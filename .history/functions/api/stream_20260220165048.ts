/**
 * Sudoku Protocol - Cloudflare Pages Function
 * WebSocket 代理端点: /api/stream
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

// 导入共享的 WASM 处理逻辑
// 注意: Pages Functions 使用文件系统路由，代码结构需要调整

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  
  // 检查 WebSocket 升级
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return new Response('Expected WebSocket', { status: 400 });
  }
  
  // 验证子协议
  const subprotocolHeader = request.headers.get('Sec-WebSocket-Protocol');
  const expectedSubprotocol = 'sudoku-tcp-v1';
  
  if (subprotocolHeader !== expectedSubprotocol) {
    console.warn(`WebSocket subprotocol mismatch: expected '${expectedSubprotocol}', got '${subprotocolHeader || 'none'}'`);
  }
  
  // 实例化 WASM
  const wasmInstance = new WebAssembly.Instance(env.SUDOKU_WASM, {
    env: { abort: () => { throw new Error('Wasm abort'); } }
  });
  
  // 创建 WebSocket pair
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair) as [WebSocket, WebSocket];
  
  // 处理 Sudoku 协议
  context.waitUntil(handleSudokuWebSocket(server, env, wasmInstance.exports as any));
  
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: { 'Sec-WebSocket-Protocol': expectedSubprotocol }
  });
};

async function handleSudokuWebSocket(
  ws: WebSocket,
  env: Env,
  wasmExports: any
): Promise<void> {
  // 接受 WebSocket 连接
  ws.accept();
  
  const keyHex = env.SUDOKU_KEY;
  const keyBytes = hexToBytes(keyHex);
  const upstreamHost = env.UPSTREAM_HOST || '127.0.0.1';
  const upstreamPort = parseInt(env.UPSTREAM_PORT || '8080', 10);
  
  // 初始化 WASM 会话
  const keyPtr = wasmExports.arenaMalloc(keyBytes.length);
  const keyMem = new Uint8Array(wasmExports.memory.buffer, keyPtr, keyBytes.length);
  keyMem.set(keyBytes);
  
  // 获取 cipher 类型
  const cipherType = getCipherType(env.CIPHER_METHOD || 'chacha20-poly1305');
  const layoutType = getLayoutType(env.LAYOUT_MODE || 'ascii');
  
  // 初始化会话
  const sessionId = wasmExports.initSession(keyPtr, keyBytes.length, cipherType, layoutType);
  
  if (sessionId < 0) {
    console.error('[Sudoku] WASM initSession failed, sessionId:', sessionId);
    ws.close(1011, 'WASM session init failed');
    wasmExports.arenaFree(keyPtr);
    return;
  }
  
  console.log('[Sudoku] Session initialized, sessionId:', sessionId);
  
  // 连接到上游服务器
  let upstreamSocket: Socket | null = null;
  try {
    upstreamSocket = connect({ hostname: upstreamHost, port: upstreamPort });
    console.log(`[Sudoku] Connected to upstream ${upstreamHost}:${upstreamPort}`);
  } catch (err) {
    console.error('[Sudoku] Failed to connect upstream:', err);
    ws.close(1011, 'Upstream connection failed');
    wasmExports.closeSession(sessionId);
    wasmExports.arenaFree(keyPtr);
    return;
  }
  
  // 设置消息处理
  const aead = new SudokuAEAD(wasmExports, sessionId, keyBytes);
  
  ws.addEventListener('message', async (event) => {
    try {
      const data = event.data as ArrayBuffer;
      const plaintext = await aead.decrypt(new Uint8Array(data));
      await upstreamSocket.write(plaintext);
    } catch (err) {
      console.error('[Sudoku] Decrypt/write error:', err);
      ws.close(1011, 'Protocol error');
    }
  });
  
  ws.addEventListener('close', () => {
    console.log('[Sudoku] WebSocket closed, cleaning up');
    wasmExports.closeSession(sessionId);
    wasmExports.arenaFree(keyPtr);
    upstreamSocket.close();
  });
  
  ws.addEventListener('error', (err) => {
    console.error('[Sudoku] WebSocket error:', err);
    wasmExports.closeSession(sessionId);
    wasmExports.arenaFree(keyPtr);
    upstreamSocket.close();
  });
  
  // 读取上游数据并加密转发
  (async () => {
    const reader = upstreamSocket.readable.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          ws.close(1000, 'Upstream closed');
          break;
        }
        const ciphertext = await aead.encrypt(value);
        const masked = maskData(wasmExports, sessionId, ciphertext);
        ws.send(masked);
      }
    } catch (err) {
      console.error('[Sudoku] Upstream read error:', err);
      ws.close(1011, 'Upstream error');
    }
  })();
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
  const mem = new Uint8Array(wasm.memory.buffer, ptr, data.length);
  mem.set(data);
  wasm.mask(sessionId, ptr, data.length);
  const result = new Uint8Array(mem);
  wasm.arenaFree(ptr);
  return result;
}

// AEAD 加密类
class SudokuAEAD {
  constructor(
    private wasm: any,
    private sessionId: number,
    private key: Uint8Array
  ) {}
  
  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    // 使用 Web Crypto API 进行加密
    // 实际实现需要根据 cipher 类型选择算法
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const algorithm = { name: 'AES-GCM', iv };
    
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      this.key.slice(0, 16),
      'AES-GCM',
      false,
      ['encrypt']
    );
    
    const ciphertext = await crypto.subtle.encrypt(
      algorithm,
      cryptoKey,
      plaintext
    );
    
    // 组合 IV + ciphertext
    const result = new Uint8Array(iv.length + ciphertext.byteLength);
    result.set(iv);
    result.set(new Uint8Array(ciphertext), iv.length);
    return result;
  }
  
  async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    const iv = ciphertext.slice(0, 12);
    const data = ciphertext.slice(12);
    
    const algorithm = { name: 'AES-GCM', iv };
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      this.key.slice(0, 16),
      'AES-GCM',
      false,
      ['decrypt']
    );
    
    const plaintext = await crypto.subtle.decrypt(
      algorithm,
      cryptoKey,
      data
    );
    
    return new Uint8Array(plaintext);
  }
}
