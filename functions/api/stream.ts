/**
 * Sudoku Protocol - Cloudflare Pages Function
 * WebSocket 代理端点: /api/stream
 * 
 * WASM 模块通过 ESM import 直接加载（Pages Functions 推荐方式）
 */

import { connect } from 'cloudflare:sockets';
// ESM 方式导入 WASM 模块
import sudokuWasmModule from '../../sudoku.wasm';

interface Env {
  SUDOKU_KEY: string;
  UPSTREAM_HOST: string;
  CIPHER_METHOD: string;
  LAYOUT_MODE: string;
  KEY_DERIVE_SALT: string;
  ED25519_PRIVATE_KEY?: string;
}

// 全局 WASM 实例缓存（避免每次请求都重新实例化）
let wasmInstanceCache: WebAssembly.Instance | null = null;
let wasmMemoryCache: WebAssembly.Memory | null = null;

async function getWasmInstance(): Promise<WebAssembly.Instance> {
  if (wasmInstanceCache && wasmMemoryCache) {
    return wasmInstanceCache;
  }
  
  console.log('[WASM] Starting instantiation...');
  
  try {
    // 实例化 WASM 模块 - 添加 WASI 支持
    const instance = await WebAssembly.instantiate(sudokuWasmModule, {
      wasi_snapshot_preview1: {
        // WASI 标准函数存根
        fd_close: () => 0,
        fd_write: () => 0,
        fd_seek: () => 0,
        fd_fdstat_get: () => 0,
        fd_prestat_get: () => 0,
        fd_prestat_dir_name: () => 0,
        environ_sizes_get: () => 0,
        environ_get: () => 0,
        args_sizes_get: () => 0,
        args_get: () => 0,
        proc_exit: (code: number) => { 
          console.error(`[WASM] proc_exit called with code ${code}`);
          throw new Error(`Exit ${code}`); 
        },
        clock_time_get: () => 0,
        random_get: (buf: number, len: number) => {
          // 使用缓存的 memory
          if (!wasmMemoryCache) {
            console.error('[WASM] random_get called before memory initialized');
            return 0;
          }
          try {
            const arr = new Uint8Array(wasmMemoryCache.buffer, buf, len);
            crypto.getRandomValues(arr);
            return 0;
          } catch (e) {
            console.error('[WASM] random_get error:', e);
            return 0;
          }
        },
      },
      env: { 
        abort: (msg: number, file: number, line: number, col: number) => {
          console.error(`[WASM Abort] msg=${msg}, file=${file}, line=${line}, col=${col}`);
          throw new Error('Wasm abort'); 
        }
      }
    });
    
    console.log('[WASM] Instantiation successful');
    
    // 获取 memory 并缓存
    const exports = instance.exports as any;
    if (!exports.memory) {
      throw new Error('WASM exports.memory not found');
    }
    wasmMemoryCache = exports.memory as WebAssembly.Memory;
    console.log(`[WASM] Memory size: ${wasmMemoryCache.buffer.byteLength} bytes`);
    
    // 检查必要的导出函数
    const required = ['arenaMalloc', 'arenaFree', 'initSession', 'closeSession', 'mask', 'unmask'];
    for (const name of required) {
      if (typeof exports[name] !== 'function') {
        throw new Error(`WASM missing required export: ${name}`);
      }
    }
    console.log('[WASM] All required exports found');
    
    // 初始化 WASM 全局状态
    if (exports.initWasm) {
      console.log('[WASM] Calling initWasm...');
      const initResult = exports.initWasm();
      console.log(`[WASM] initWasm returned: ${initResult}`);
    } else {
      console.warn('[WASM] initWasm not found, skipping initialization');
    }
    
    wasmInstanceCache = instance;
    return instance;
  } catch (err) {
    console.error('[WASM] Instantiation failed:', err);
    throw err;
  }
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  
  console.log(`[Sudoku] Request received: ${request.method} ${request.url}`);
  
  // 检查 WebSocket 升级
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return new Response('Expected WebSocket Upgrade', { 
      status: 400,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
  
  console.log(`[Sudoku] WebSocket request from ${request.headers.get('CF-Connecting-IP') || 'unknown'}`);
  
  try {
    // 获取 WASM 实例
    const wasmInstance = await getWasmInstance();
    const wasmExports = wasmInstance.exports as any;
    
    console.log('[Sudoku] WASM loaded successfully');
    
    // 创建 WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    
    // 处理 Sudoku 协议
    context.waitUntil(handleSudokuConnection(server, env, wasmExports));
    
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
    
  } catch (err) {
    console.error('[Sudoku] Failed to initialize:', err);
    return new Response(`Internal Server Error: ${err}`, { status: 500 });
  }
};

async function handleSudokuConnection(
  ws: WebSocket,
  env: Env,
  wasm: any
): Promise<void> {
  ws.accept();
  console.log('[Sudoku] WebSocket accepted');
  
  const keyHex = env.SUDOKU_KEY;
  console.log(`[Sudoku] Key length: ${keyHex?.length || 0}`);
  
  if (!keyHex || keyHex.length !== 64) {
    console.error(`[Sudoku] Invalid key: length=${keyHex?.length}, expected=64`);
    ws.close(1011, 'Invalid key');
    return;
  }
  
  const keyBytes = hexToBytes(keyHex);
  const upstreamHost = env.UPSTREAM_HOST || '127.0.0.1';
  const upstreamPort = 443; // Cloudflare Workers/Pages 出站只能使用 443
  
  console.log(`[Sudoku] Connecting to ${upstreamHost}:${upstreamPort}`);
  
  const keyPtr = wasm.arenaMalloc(keyBytes.length);
  if (!keyPtr) {
    console.error('[Sudoku] Memory alloc failed');
    ws.close(1011, 'Memory error');
    return;
  }
  
  console.log(`[Sudoku] Memory allocated at ${keyPtr}`);
  
  try {
    const memory = new Uint8Array(wasm.memory.buffer);
    memory.set(keyBytes, keyPtr);
    
    const cipherType = getCipherType(env.CIPHER_METHOD || 'chacha20-poly1305');
    const layoutType = getLayoutType(env.LAYOUT_MODE || 'ascii');
    
    // initSession 签名: (keyPtr, keyLen, cipherType, layoutType)
    // 返回值: sessionId (>=0 成功, <0 失败)
    console.log(`[Sudoku] Calling initSession: keyLen=${keyBytes.length}, cipher=${cipherType}, layout=${layoutType}`);
    const sessionId = wasm.initSession(keyPtr, keyBytes.length, cipherType, layoutType);
    console.log(`[Sudoku] initSession returned: ${sessionId}`);
    
    if (sessionId < 0) {
      console.error(`[Sudoku] Init failed with error code: ${sessionId}`);
      ws.close(1011, `Init failed: ${sessionId}`);
      return;
    }
    
    console.log(`[Sudoku] Session ${sessionId} created`);
    
    // 连接上游
    let upstreamSocket: Socket;
    try {
      upstreamSocket = connect({ hostname: upstreamHost, port: upstreamPort });
    } catch (err) {
      console.error('[Sudoku] Connect failed:', err);
      wasm.closeSession(sessionId);
      ws.close(1011, 'Connect failed');
      return;
    }
    
    const aead = new SudokuAEAD(wasm, sessionId, keyBytes);
    
    const cleanup = () => {
      try {
        wasm.closeSession(sessionId);
        wasm.arenaFree(keyPtr);
        upstreamSocket.close();
      } catch (e) {}
    };
    
    ws.addEventListener('message', async (event) => {
      try {
        const data = event.data as ArrayBuffer;
        const plaintext = await aead.decrypt(new Uint8Array(data));
        await upstreamSocket.write(plaintext);
      } catch (err) {
        console.error('[Sudoku] Decrypt error:', err);
        ws.close(1011, 'Protocol error');
        cleanup();
      }
    });
    
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
    
    // 上游读取循环
    const reader = upstreamSocket.readable.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          ws.close(1000, 'Upstream closed');
          break;
        }
        const ciphertext = await aead.encrypt(value);
        const masked = maskData(wasm, sessionId, ciphertext);
        ws.send(masked);
      }
    } catch (err) {
      ws.close(1011, 'Upstream error');
      cleanup();
    }
    
  } catch (err) {
    console.error('[Sudoku] Error:', err);
    wasm.arenaFree(keyPtr);
    ws.close(1011, 'Error');
  }
}

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
  if (!ptr) throw new Error('Alloc failed');
  
  try {
    const memory = new Uint8Array(wasm.memory.buffer);
    memory.set(data, ptr);
    wasm.mask(sessionId, ptr, data.length);
    const result = new Uint8Array(data.length);
    result.set(memory.subarray(ptr, ptr + data.length));
    return result;
  } finally {
    wasm.arenaFree(ptr);
  }
}

class SudokuAEAD {
  constructor(
    private wasm: any,
    private sessionId: number,
    private key: Uint8Array
  ) {}
  
  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await crypto.subtle.importKey(
      'raw', this.key.slice(0, 16), 'AES-GCM', false, ['encrypt']
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, cryptoKey, plaintext
    );
    const result = new Uint8Array(iv.length + ciphertext.byteLength);
    result.set(iv);
    result.set(new Uint8Array(ciphertext), iv.length);
    return result;
  }
  
  async decrypt(data: Uint8Array): Promise<Uint8Array> {
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);
    const cryptoKey = await crypto.subtle.importKey(
      'raw', this.key.slice(0, 16), 'AES-GCM', false, ['decrypt']
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, cryptoKey, ciphertext
    );
    return new Uint8Array(plaintext);
  }
}
