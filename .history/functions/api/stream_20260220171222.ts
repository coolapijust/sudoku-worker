/**
 * Sudoku Protocol - Cloudflare Pages Function
 * WebSocket 代理端点: /api/stream
 */

import { connect } from 'cloudflare:sockets';

interface Env {
  SUDOKU_WASM: WebAssembly.Module | ArrayBuffer;
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
  
  console.log(`[Sudoku] WebSocket request from ${request.headers.get('CF-Connecting-IP') || 'unknown'}`);
  
  try {
    // 检查 WASM 模块
    if (!env.SUDOKU_WASM) {
      console.error('[Sudoku] SUDOKU_WASM not bound');
      return new Response('WASM module not configured', { status: 500 });
    }
    
    console.log('[Sudoku] WASM module type:', typeof env.SUDOKU_WASM, env.SUDOKU_WASM.constructor?.name);
    
    // 实例化 WASM - Pages 可能传入 Module 或 ArrayBuffer
    let wasmModule: WebAssembly.Module;
    if (env.SUDOKU_WASM instanceof WebAssembly.Module) {
      wasmModule = env.SUDOKU_WASM;
    } else if (env.SUDOKU_WASM instanceof ArrayBuffer) {
      wasmModule = await WebAssembly.compile(env.SUDOKU_WASM);
    } else {
      // 尝试作为 Module 使用
      wasmModule = env.SUDOKU_WASM as WebAssembly.Module;
    }
    
    const wasmInstance = new WebAssembly.Instance(wasmModule, {
      env: { 
        abort: () => { throw new Error('Wasm abort'); }
      }
    });
    
    const wasmExports = wasmInstance.exports as any;
    
    // 检查必要的导出函数
    if (!wasmExports.arenaMalloc || !wasmExports.initSession) {
      console.error('[Sudoku] WASM missing required exports');
      return new Response('WASM module invalid', { status: 500 });
    }
    
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
  if (!keyHex || keyHex.length !== 64) {
    console.error('[Sudoku] Invalid key');
    ws.close(1011, 'Invalid key');
    return;
  }
  
  const keyBytes = hexToBytes(keyHex);
  const upstreamHost = env.UPSTREAM_HOST || '127.0.0.1';
  const upstreamPort = parseInt(env.UPSTREAM_PORT || '8080', 10);
  
  console.log(`[Sudoku] Connecting to ${upstreamHost}:${upstreamPort}`);
  
  const keyPtr = wasm.arenaMalloc(keyBytes.length);
  if (!keyPtr) {
    console.error('[Sudoku] Memory alloc failed');
    ws.close(1011, 'Memory error');
    return;
  }
  
  try {
    const memory = new Uint8Array(wasm.memory.buffer);
    memory.set(keyBytes, keyPtr);
    
    const cipherType = getCipherType(env.CIPHER_METHOD || 'chacha20-poly1305');
    const layoutType = getLayoutType(env.LAYOUT_MODE || 'ascii');
    
    const sessionId = wasm.initSession(keyPtr, keyBytes.length, cipherType, layoutType);
    
    if (sessionId < 0) {
      console.error(`[Sudoku] Init failed: ${sessionId}`);
      ws.close(1011, 'Init failed');
      return;
    }
    
    console.log(`[Sudoku] Session ${sessionId}`);
    
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
