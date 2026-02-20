/**
 * Sudoku Protocol - Cloudflare Pages Function
 * WebSocket 代理端点: /api/stream
 * 
 * 适配 Pages Functions 的 WebSocket 处理方式
 */

import { connect } from 'cloudflare:sockets';

interface Env {
  SUDOKU_WASM: WebAssembly.Module;
  SUDOKU_KEY: string;
  UPSTREAM_HOST: string;
  UPSTREAM_PORT: string;
  CIPHER_METHOD: string;
  LAYOUT_MODE: string;
  KEY_DERIVE_SALT: string;
  ED25519_PRIVATE_KEY?: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  
  // 检查 WebSocket 升级
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return new Response('Expected WebSocket Upgrade', { 
      status: 400,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
  
  // 验证子协议
  const subprotocolHeader = request.headers.get('Sec-WebSocket-Protocol');
  const expectedSubprotocol = 'sudoku-tcp-v1';
  
  console.log(`[Sudoku] WebSocket request from ${request.headers.get('CF-Connecting-IP')}`);
  console.log(`[Sudoku] Subprotocol: ${subprotocolHeader || 'none'}`);
  
  if (subprotocolHeader !== expectedSubprotocol) {
    console.warn(`[Sudoku] Subprotocol mismatch: expected '${expectedSubprotocol}', got '${subprotocolHeader || 'none'}'`);
  }
  
  try {
    // 实例化 WASM
    const wasmInstance = new WebAssembly.Instance(env.SUDOKU_WASM, {
      env: { 
        abort: (msg: string, file: string, line: number, col: number) => {
          console.error(`[WASM Abort] ${msg} at ${file}:${line}:${col}`);
          throw new Error('Wasm abort'); 
        }
      }
    });
    
    const wasmExports = wasmInstance.exports as any;
    
    // 创建 WebSocket pair - Pages 使用标准的 WebSocketPair
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    
    // 处理 Sudoku 协议
    context.waitUntil(handleSudokuConnection(server, env, wasmExports));
    
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 
        'Sec-WebSocket-Protocol': expectedSubprotocol,
        'Upgrade': 'websocket',
        'Connection': 'Upgrade'
      }
    });
    
  } catch (err) {
    console.error('[Sudoku] Failed to initialize:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
};

async function handleSudokuConnection(
  ws: WebSocket,
  env: Env,
  wasm: any
): Promise<void> {
  // 接受 WebSocket 连接
  ws.accept();
  console.log('[Sudoku] WebSocket connection accepted');
  
  const keyHex = env.SUDOKU_KEY;
  if (!keyHex || keyHex.length !== 64) {
    console.error('[Sudoku] Invalid SUDOKU_KEY');
    ws.close(1011, 'Invalid key configuration');
    return;
  }
  
  const keyBytes = hexToBytes(keyHex);
  const upstreamHost = env.UPSTREAM_HOST || '127.0.0.1';
  const upstreamPort = parseInt(env.UPSTREAM_PORT || '8080', 10);
  
  console.log(`[Sudoku] Upstream: ${upstreamHost}:${upstreamPort}`);
  
  // 分配 WASM 内存
  const keyPtr = wasm.arenaMalloc(keyBytes.length);
  if (keyPtr === 0) {
    console.error('[Sudoku] Failed to allocate WASM memory');
    ws.close(1011, 'Memory allocation failed');
    return;
  }
  
  try {
    // 写入密钥到 WASM 内存
    const memory = new Uint8Array(wasm.memory.buffer);
    memory.set(keyBytes, keyPtr);
    
    // 获取 cipher 和 layout 类型
    const cipherType = getCipherType(env.CIPHER_METHOD || 'chacha20-poly1305');
    const layoutType = getLayoutType(env.LAYOUT_MODE || 'ascii');
    
    console.log(`[Sudoku] Cipher: ${cipherType}, Layout: ${layoutType}`);
    
    // 初始化会话
    const sessionId = wasm.initSession(keyPtr, keyBytes.length, cipherType, layoutType);
    
    if (sessionId < 0) {
      console.error(`[Sudoku] WASM initSession failed: ${sessionId}`);
      ws.close(1011, 'Session initialization failed');
      return;
    }
    
    console.log(`[Sudoku] Session initialized: ${sessionId}`);
    
    // 连接到上游 TCP 服务器
    let upstreamSocket: Socket;
    try {
      upstreamSocket = connect({ hostname: upstreamHost, port: upstreamPort });
      console.log(`[Sudoku] Connected to upstream ${upstreamHost}:${upstreamPort}`);
    } catch (err) {
      console.error('[Sudoku] Upstream connection failed:', err);
      wasm.closeSession(sessionId);
      ws.close(1011, 'Upstream connection failed');
      return;
    }
    
    // 创建 AEAD 实例
    const aead = new SudokuAEAD(wasm, sessionId, keyBytes);
    
    // 设置清理函数
    const cleanup = () => {
      console.log('[Sudoku] Cleaning up session');
      try {
        wasm.closeSession(sessionId);
        wasm.arenaFree(keyPtr);
        upstreamSocket.close();
      } catch (e) {
        console.error('[Sudoku] Cleanup error:', e);
      }
    };
    
    // 处理 WebSocket 消息（客户端 -> 上游）
    ws.addEventListener('message', async (event) => {
      try {
        const data = event.data as ArrayBuffer;
        console.log(`[Sudoku] Received ${data.byteLength} bytes from client`);
        
        const plaintext = await aead.decrypt(new Uint8Array(data));
        await upstreamSocket.write(plaintext);
        console.log(`[Sudoku] Forwarded ${plaintext.length} bytes to upstream`);
      } catch (err) {
        console.error('[Sudoku] Decrypt/forward error:', err);
        ws.close(1011, 'Protocol error');
        cleanup();
      }
    });
    
    ws.addEventListener('close', (event) => {
      console.log(`[Sudoku] WebSocket closed: ${event.code} ${event.reason}`);
      cleanup();
    });
    
    ws.addEventListener('error', (err) => {
      console.error('[Sudoku] WebSocket error:', err);
      cleanup();
    });
    
    // 读取上游数据并转发（上游 -> 客户端）
    try {
      const reader = upstreamSocket.readable.getReader();
      
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          console.log('[Sudoku] Upstream closed connection');
          ws.close(1000, 'Upstream closed');
          break;
        }
        
        console.log(`[Sudoku] Received ${value.length} bytes from upstream`);
        
        const ciphertext = await aead.encrypt(value);
        const masked = maskData(wasm, sessionId, ciphertext);
        
        ws.send(masked);
        console.log(`[Sudoku] Sent ${masked.byteLength} bytes to client`);
      }
    } catch (err) {
      console.error('[Sudoku] Upstream read error:', err);
      ws.close(1011, 'Upstream error');
      cleanup();
    }
    
  } catch (err) {
    console.error('[Sudoku] Fatal error:', err);
    wasm.arenaFree(keyPtr);
    ws.close(1011, 'Internal error');
  }
}

// 辅助函数
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function getCipherType(method: string): number {
  const map: Record<string, number> = {
    'chacha20-poly1305': 0,
    'aes-128-gcm': 1,
    'aes-256-gcm': 2,
  };
  return map[method.toLowerCase()] ?? 0;
}

function getLayoutType(mode: string): number {
  const map: Record<string, number> = {
    'ascii': 0,
    'binary': 1,
  };
  return map[mode.toLowerCase()] ?? 0;
}

function maskData(wasm: any, sessionId: number, data: Uint8Array): Uint8Array {
  const ptr = wasm.arenaMalloc(data.length);
  if (ptr === 0) {
    throw new Error('Failed to allocate memory for masking');
  }
  
  try {
    const memory = new Uint8Array(wasm.memory.buffer);
    memory.set(data, ptr);
    
    // 调用 WASM mask 函数
    wasm.mask(sessionId, ptr, data.length);
    
    // 读取结果
    const result = new Uint8Array(data.length);
    result.set(memory.subarray(ptr, ptr + data.length));
    
    return result;
  } finally {
    wasm.arenaFree(ptr);
  }
}

// AEAD 加密类
class SudokuAEAD {
  constructor(
    private wasm: any,
    private sessionId: number,
    private key: Uint8Array
  ) {}
  
  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    // 使用 Web Crypto API 进行 AES-GCM 加密
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      this.key.slice(0, 16), // AES-128 使用 16 字节密钥
      'AES-GCM',
      false,
      ['encrypt']
    );
    
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      plaintext
    );
    
    // 组合 IV + ciphertext
    const result = new Uint8Array(iv.length + ciphertext.byteLength);
    result.set(iv);
    result.set(new Uint8Array(ciphertext), iv.length);
    
    return result;
  }
  
  async decrypt(data: Uint8Array): Promise<Uint8Array> {
    if (data.length < 12) {
      throw new Error('Ciphertext too short');
    }
    
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);
    
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      this.key.slice(0, 16),
      'AES-GCM',
      false,
      ['decrypt']
    );
    
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      ciphertext
    );
    
    return new Uint8Array(plaintext);
  }
}
