/**
 * Sudoku Protocol - Cloudflare Worker Bridge
 * TinyGo Wasm 纯计算核心 + TypeScript 事件流桥接
 * 
 * 路径伪装:
 * - /v2/stream (WebSocket): Sudoku 协议代理
 * - 其他所有路径: 返回研究站 HTML
 * 
 * 加密支持:
 * - ChaCha20-Poly1305: Wasm 内实现 (官方移植)
 * - AES-128-GCM: Worker Web Crypto API
 */

import { connect } from 'cloudflare:sockets';

// 研究站 HTML (反引号已替换为单引号)
import { SUDOKU_SITE_HTML } from './src/site';


// Wasm 模块类型定义
interface SudokuWasmExports {
  memory: WebAssembly.Memory;
  arenaMalloc: (size: number) => number;
  arenaFree: (ptr: number) => void;
  initSession: (keyPtr: number, keyLen: number, cipherType: number, layoutType: number) => number;
  closeSession: (id: number) => void;
  mask: (id: number, inPtr: number, inLen: number) => number;
  unmask: (id: number, inPtr: number, inLen: number) => number;
  getOutLen: () => number;
  aeadEncrypt: (id: number, plaintextPtr: number, plaintextLen: number, outPtr: number) => number;
  aeadDecrypt: (id: number, ciphertextPtr: number, ciphertextLen: number, outPtr: number) => number;
  initCodecTablesWithKey: (keyPtr: number, keyLen: number) => void;
}

const CipherType = { None: 0, AES128GCM: 1, ChaCha20Poly: 2 };
const LayoutType = { ASCII: 0, Entropy: 1 };

class WasmInstance {
  private exports: SudokuWasmExports;
  private initialized: boolean = false;

  constructor(wasmModule: WebAssembly.Module) {
    const instance = new WebAssembly.Instance(wasmModule, { env: { abort: () => { throw new Error('Wasm abort'); } } });
    this.exports = instance.exports as unknown as SudokuWasmExports;
  }

  // Public accessor for exports
  getExports(): SudokuWasmExports { return this.exports; }

  getMemory(): Uint8Array { return new Uint8Array(this.exports.memory.buffer); }

  writeToMemory(data: Uint8Array): [number, boolean] {
    const ptr = this.exports.arenaMalloc(data.length);
    if (ptr === 0) throw new Error('Wasm arenaMalloc failed');
    this.getMemory().set(data, ptr);
    return [ptr, true];
  }

  readFromMemory(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer, ptr, len).slice();
  }

  initCodecTables(key: Uint8Array): void {
    if (this.initialized) return;
    const [keyPtr, needFree] = this.writeToMemory(key.slice(0, 32));
    try {
      this.exports.initCodecTablesWithKey(keyPtr, key.length);
      this.initialized = true;
    } finally { if (needFree) this.exports.arenaFree(keyPtr); }
  }

  initSession(cipherType: number): number {
    const dummyKey = new Uint8Array(32);
    const [keyPtr, needFree] = this.writeToMemory(dummyKey);
    try {
      const sessionId = this.exports.initSession(keyPtr, dummyKey.length, cipherType, LayoutType.ASCII);
      if (sessionId < 0) throw new Error(`Failed to init session: ${sessionId}`);
      return sessionId;
    } finally { if (needFree) this.exports.arenaFree(keyPtr); }
  }

  closeSession(sessionId: number): void { this.exports.closeSession(sessionId); }

  mask(sessionId: number, data: Uint8Array): Uint8Array {
    const [inPtr, needFree] = this.writeToMemory(data);
    try {
      const outPtr = this.exports.mask(sessionId, inPtr, data.length);
      const outLen = this.exports.getOutLen();
      if (outPtr === 0 || outLen === 0) return new Uint8Array(0);
      return this.readFromMemory(outPtr, outLen);
    } finally { if (needFree) this.exports.arenaFree(inPtr); }
  }

  unmask(sessionId: number, data: Uint8Array): Uint8Array {
    const [inPtr, needFree] = this.writeToMemory(data);
    try {
      const outPtr = this.exports.unmask(sessionId, inPtr, data.length);
      const outLen = this.exports.getOutLen();
      if (outPtr === 0 || outLen === 0) return new Uint8Array(0);
      return this.readFromMemory(outPtr, outLen);
    } finally { if (needFree) this.exports.arenaFree(inPtr); }
  }

  aeadEncrypt(sessionId: number, plaintext: Uint8Array): Uint8Array {
    const [inPtr] = this.writeToMemory(plaintext);
    const outPtr = this.exports.arenaMalloc(plaintext.length + 16);
    if (outPtr === 0) { this.exports.arenaFree(inPtr); throw new Error('Failed to allocate output buffer'); }
    try {
      const resultLen = this.exports.aeadEncrypt(sessionId, inPtr, plaintext.length, outPtr);
      if (resultLen === 0) throw new Error('AEAD encryption failed');
      return this.readFromMemory(outPtr, resultLen);
    } finally { this.exports.arenaFree(inPtr); this.exports.arenaFree(outPtr); }
  }

  aeadDecrypt(sessionId: number, ciphertext: Uint8Array): Uint8Array {
    const [inPtr] = this.writeToMemory(ciphertext);
    const outPtr = this.exports.arenaMalloc(ciphertext.length);
    if (outPtr === 0) { this.exports.arenaFree(inPtr); throw new Error('Failed to allocate output buffer'); }
    try {
      const resultLen = this.exports.aeadDecrypt(sessionId, inPtr, ciphertext.length, outPtr);
      if (resultLen === 0) throw new Error('AEAD decryption failed');
      return this.readFromMemory(outPtr, resultLen);
    } finally { this.exports.arenaFree(inPtr); this.exports.arenaFree(outPtr); }
  }
}

class AeadManager {
  private key: Uint8Array;
  private cryptoKey: CryptoKey | null = null;
  private cipherType: number;
  private wasm: WasmInstance;
  private sessionId: number;

  constructor(method: string, key: Uint8Array, wasm: WasmInstance, sessionId: number) {
    this.key = key.slice(0, 32);
    this.cipherType = this.parseCipherMethod(method);
    this.wasm = wasm;
    this.sessionId = sessionId;
  }

  private parseCipherMethod(method: string): number {
    if (method.toLowerCase().includes('aes')) return CipherType.AES128GCM;
    if (method.toLowerCase().includes('chacha20')) return CipherType.ChaCha20Poly;
    return CipherType.None;
  }

  async init(): Promise<void> {
    if (this.cipherType === CipherType.AES128GCM) {
      this.cryptoKey = await crypto.subtle.importKey('raw', this.key.slice(0, 16), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    }
  }

  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    let ciphertext: Uint8Array;

    switch (this.cipherType) {
      case CipherType.None:
        ciphertext = plaintext;
        break;
      case CipherType.ChaCha20Poly:
        ciphertext = this.wasm.aeadEncrypt(this.sessionId, plaintext);
        break;
      case CipherType.AES128GCM:
        if (!this.cryptoKey) throw new Error('CryptoKey not initialized');
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, this.cryptoKey, plaintext);
        ciphertext = new Uint8Array(12 + encrypted.byteLength);
        ciphertext.set(nonce);
        ciphertext.set(new Uint8Array(encrypted), 12);
        break;
      default:
        throw new Error(`Unsupported cipher: ${this.cipherType}`);
    }

    // 添加 2 字节帧长度头 (大端序)，与原版 Go 协议一致
    const frameLen = ciphertext.length;
    const frame = new Uint8Array(2 + frameLen);
    frame[0] = (frameLen >> 8) & 0xFF;  // 大端序高字节
    frame[1] = frameLen & 0xFF;           // 大端序低字节
    frame.set(ciphertext, 2);

    return frame;
  }

  async decrypt(data: Uint8Array): Promise<Uint8Array> {
    // 读取 2 字节帧长度头 (大端序)
    if (data.length < 2) {
      throw new Error('Frame too short: missing length header');
    }
    const frameLen = (data[0] << 8) | data[1];

    if (data.length < 2 + frameLen) {
      throw new Error(`Incomplete frame: expected ${frameLen} bytes, got ${data.length - 2}`);
    }

    const ciphertext = data.subarray(2, 2 + frameLen);

    let plaintext: Uint8Array;

    switch (this.cipherType) {
      case CipherType.None:
        plaintext = ciphertext;
        break;
      case CipherType.ChaCha20Poly:
        plaintext = this.wasm.aeadDecrypt(this.sessionId, ciphertext);
        break;
      case CipherType.AES128GCM:
        if (!this.cryptoKey) throw new Error('CryptoKey not initialized');
        if (ciphertext.length < 12) throw new Error('Ciphertext too short: missing nonce');
        const nonce = ciphertext.slice(0, 12);
        const encrypted = ciphertext.slice(12);
        plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, this.cryptoKey, encrypted));
        break;
      default:
        throw new Error(`Unsupported cipher: ${this.cipherType}`);
    }

    return plaintext;
  }
}

/**
 * Worker 配置接口
 * 
 * 密钥管理:
 * - Secrets (敏感，加密存储): SUDOKU_KEY, ED25519_PRIVATE_KEY
 *   使用: wrangler secret put KEY_NAME
 * 
 * - Vars (公开，明文存储): ED25519_PUBLIC_KEY, UPSTREAM_HOST 等
 *   在 wrangler.toml [vars] 段配置
 */
interface Env {
  // 上游服务器配置
  UPSTREAM_HOST: string;
  UPSTREAM_PORT: string;

  // AEAD 对称加密密钥 (Secret)
  // 格式: 32字节 hex (64字符)，用于 ChaCha20-Poly1305 或 AES-GCM
  SUDOKU_KEY: string;

  // 加密方法: "none" | "aes-128-gcm" | "chacha20-poly1305"
  CIPHER_METHOD: string;

  // Sudoku 布局模式: "ascii" | "entropy"
  LAYOUT_MODE: string;

  // Ed25519 公钥 (可选，Vars，可公开)
  // 格式: 32字节 hex (64字符)，用于 Worker 身份验证
  ED25519_PUBLIC_KEY?: string;

  // Ed25519 私钥 (可选，Secret)
  // 格式: 32字节 hex (64字符)，用于签名证明身份
  ED25519_PRIVATE_KEY?: string;

  // 密钥派生盐值 (可选)
  // 用于从密码派生密钥 (PBKDF2)
  KEY_DERIVE_SALT?: string;

  // Wasm 模块
  SUDOKU_WASM: WebAssembly.Module;
}

/**
 * 从字符串派生密钥 (SHA-256)
 * 如果输入是 hex 字符串 (64字符)，先解码再 hash
 */
async function deriveKey(keyStr: string): Promise<Uint8Array> {
  // 检查是否是 hex 编码 (64字符 = 32字节)
  if (/^[0-9a-fA-F]{64}$/.test(keyStr)) {
    return hexToBytes(keyStr);
  }
  // 否则使用 SHA-256 派生
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyStr)));
}

/**
 * Hex 字符串转 Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Uint8Array 转 Hex 字符串
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 密钥配置验证
 */
function validateKeyConfig(env: Env): void {
  // 验证 SUDOKU_KEY 格式
  if (!env.SUDOKU_KEY) {
    throw new Error('SUDOKU_KEY is required (set via: wrangler secret put SUDOKU_KEY)');
  }

  // 如果是 hex 格式，验证长度
  if (/^[0-9a-fA-F]+$/.test(env.SUDOKU_KEY)) {
    const expectedLen = env.CIPHER_METHOD === 'aes-128-gcm' ? 32 : 64; // AES-128: 16字节=32hex, ChaCha20: 32字节=64hex
    if (env.SUDOKU_KEY.length !== expectedLen) {
      console.warn(`Warning: SUDOKU_KEY hex length is ${env.SUDOKU_KEY.length}, expected ${expectedLen} for ${env.CIPHER_METHOD}`);
    }
  }

  // 验证 Ed25519 公钥 (如果配置了)
  if (env.ED25519_PUBLIC_KEY) {
    if (!/^[0-9a-fA-F]{64}$/.test(env.ED25519_PUBLIC_KEY)) {
      throw new Error('ED25519_PUBLIC_KEY must be 64 hex characters (32 bytes)');
    }
  }

  // 验证 Ed25519 私钥 (如果配置了)
  if (env.ED25519_PRIVATE_KEY) {
    if (!/^[0-9a-fA-F]{64}$/.test(env.ED25519_PRIVATE_KEY)) {
      throw new Error('ED25519_PRIVATE_KEY must be 64 hex characters (32 bytes)');
    }
  }
}

async function connectUpstream(env: Env): Promise<Socket> {
  return connect(`${env.UPSTREAM_HOST}:${env.UPSTREAM_PORT}`, { secureTransport: 'off', allowHalfOpen: false });
}

async function handleWebSocket(ws: WebSocket, env: Env, subprotocol: string = 'sudoku-tcp-v1'): Promise<void> {
  // 验证密钥配置
  validateKeyConfig(env);

  const wasm = new WasmInstance(env.SUDOKU_WASM);
  const cipherMethod = env.CIPHER_METHOD || 'none';
  let cipherType = CipherType.None;
  if (cipherMethod.toLowerCase().includes('chacha20')) cipherType = CipherType.ChaCha20Poly;
  else if (cipherMethod.toLowerCase().includes('aes')) cipherType = CipherType.AES128GCM;

  // 从 key 派生密钥数据
  const keyData = await deriveKey(env.SUDOKU_KEY || 'default-key');

  // 使用 key 初始化编解码表 (确保与原版 Go 一致的网格打乱顺序)
  wasm.initCodecTables(keyData);

  // 使用 key 初始化 session
  const [keyPtr, needFree] = wasm.writeToMemory(keyData);
  try {
    var sessionId = wasm.getExports().initSession(keyPtr, keyData.length, cipherType, LayoutType.ASCII);
  } finally { if (needFree) wasm.getExports().arenaFree(keyPtr); }

  const aead = new AeadManager(cipherMethod, keyData, wasm, sessionId);
  await aead.init();

  let upstreamSocket: Socket;
  try {
    upstreamSocket = await connectUpstream(env);
  } catch (err) {
    console.error('Failed to connect upstream:', err);
    ws.close(1011, 'Upstream connection failed');
    wasm.closeSession(sessionId);
    return;
  }

  ws.accept();
  const upstreamWriter = upstreamSocket.writable.getWriter();
  const upstreamReader = upstreamSocket.readable.getReader();

  const cleanup = () => {
    try { upstreamWriter.releaseLock(); upstreamSocket.close(); } catch { }
    try { wasm.closeSession(sessionId); } catch { }
  };

  ws.addEventListener('message', async (event) => {
    try {
      let data: Uint8Array = typeof event.data === 'string' ? new TextEncoder().encode(event.data) : new Uint8Array(event.data);
      const unmasked = wasm.unmask(sessionId, data);
      const plaintext = await aead.decrypt(unmasked);
      await upstreamWriter.write(plaintext);
    } catch (err) {
      console.error('Error processing WebSocket message:', err);
      ws.close(1011, 'Processing error');
      cleanup();
    }
  });

  ws.addEventListener('close', cleanup);
  ws.addEventListener('error', cleanup);

  (async () => {
    try {
      while (true) {
        const { done, value } = await upstreamReader.read();
        if (done) { ws.close(1000, 'Upstream closed'); break; }
        const ciphertext = await aead.encrypt(value);
        const masked = wasm.mask(sessionId, ciphertext);
        ws.send(masked);
      }
    } catch (err) {
      console.error('Error reading from upstream:', err);
      ws.close(1011, 'Upstream read error');
    } finally { cleanup(); }
  })();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get('Upgrade');
    const subprotocolHeader = request.headers.get('Sec-WebSocket-Protocol');

    const expectedSubprotocol = 'sudoku-tcp-v1';

    // 只有 /v2/stream 路径且是 WebSocket 升级才触发 Sudoku 协议
    if (url.pathname === '/v2/stream' && upgradeHeader?.toLowerCase() === 'websocket') {
      // 验证子协议协商 (原版 Go 客户端要求 sudoku-tcp-v1)
      if (subprotocolHeader !== expectedSubprotocol) {
        console.warn(`WebSocket subprotocol mismatch: expected '${expectedSubprotocol}', got '${subprotocolHeader || 'none'}'`);
      }

      const [client, server] = Object.values(new WebSocketPair());
      ctx.waitUntil(handleWebSocket(server, env, expectedSubprotocol));
      return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': expectedSubprotocol } });
    }

    // 其他所有路径返回研究站 HTML
    return new Response(SUDOKU_SITE_HTML, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' },
    });
  },
};

// Types are provided by @cloudflare/workers-types
