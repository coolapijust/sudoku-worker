/**
 * Sudoku Protocol - Cloudflare Pages Function
 * WebSocket 代理端点: /api/stream
 */

import { connect } from 'cloudflare:sockets';
import sudokuWasmModule from '../../sudoku.wasm';
import { SudokuAEAD, hexToBytes, getCipherType, getLayoutType } from './sudoku-aead';
import { handleSudokuHandshake } from './handshake';

interface Env {
  SUDOKU_KEY: string;
  UPSTREAM_HOST: string;
  CIPHER_METHOD: string;
  LAYOUT_MODE: string;
}

let wasmInstanceCache: WebAssembly.Instance | null = null;
let wasmMemoryCache: WebAssembly.Memory | null = null;

async function getWasmInstance(): Promise<WebAssembly.Instance> {
  if (wasmInstanceCache && wasmMemoryCache) {
    return wasmInstanceCache;
  }

  console.log('[WASM] Starting instantiation...');

  try {
    let moduleToInstantiate: WebAssembly.Module | Response;

    if (sudokuWasmModule instanceof WebAssembly.Module) {
      moduleToInstantiate = sudokuWasmModule;
    } else if (sudokuWasmModule instanceof Response) {
      moduleToInstantiate = sudokuWasmModule;
    } else if (typeof sudokuWasmModule === 'object' && sudokuWasmModule !== null) {
      if ('default' in sudokuWasmModule) {
        moduleToInstantiate = (sudokuWasmModule as any).default;
      } else {
        moduleToInstantiate = sudokuWasmModule as any;
      }
    } else {
      moduleToInstantiate = sudokuWasmModule as any;
    }

    const instantiated = await WebAssembly.instantiate(moduleToInstantiate, {
      wasi_snapshot_preview1: {
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
        proc_exit: (code: number) => { throw new Error(`Exit ${code}`); },
        clock_time_get: () => 0,
        random_get: (buf: number, len: number) => {
          if (!wasmMemoryCache) return 0;
          try {
            const arr = new Uint8Array(wasmMemoryCache.buffer, buf, len);
            crypto.getRandomValues(arr);
            return 0;
          } catch (e) { return 0; }
        },
      },
      env: {
        abort: (msg: number, file: number, line: number, col: number) => {
          throw new Error('Wasm abort');
        }
      }
    });

    let instance: WebAssembly.Instance;
    if ('instance' in instantiated) {
      instance = (instantiated as any).instance;
    } else {
      instance = instantiated as WebAssembly.Instance;
    }

    const exports = instance.exports as any;
    wasmMemoryCache = exports.memory as WebAssembly.Memory;
    console.log(`[WASM] Memory size: ${wasmMemoryCache.buffer.byteLength} bytes`);

    if (exports.initWasm) {
      exports.initWasm();
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
  console.log(`[Sudoku] Request: ${request.method} ${request.url}`);

  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket Upgrade', { status: 400 });
  }

  try {
    const wasmInstance = await getWasmInstance();
    const wasmExports = wasmInstance.exports as any;

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    context.waitUntil(handleSudokuConnection(server, env, wasmExports));

    return new Response(null, { status: 101, webSocket: client });
  } catch (err) {
    console.error('[Sudoku] Failed:', err);
    return new Response(`Error: ${err}`, { status: 500 });
  }
};

async function handleSudokuConnection(
  ws: WebSocket,
  env: Env,
  wasm: any
): Promise<void> {
  // 在 accept 之前先设置消息缓冲区，防止丢失客户端的第一条消息
  const messageBuffer: ArrayBuffer[] = [];
  let messageHandler: ((event: MessageEvent) => void) | null = null;
  
  const tempHandler = (event: MessageEvent) => {
    console.log('[Sudoku] Buffered message during init');
    messageBuffer.push(event.data as ArrayBuffer);
    if (messageHandler) {
      messageHandler(event);
    }
  };
  ws.addEventListener('message', tempHandler);
  
  ws.accept();
  console.log('[Sudoku] WebSocket accepted');

  const keyHex = env.SUDOKU_KEY;
  if (!keyHex || keyHex.length !== 64) {
    console.error(`[Sudoku] Invalid key: length=${keyHex?.length}`);
    ws.removeEventListener('message', tempHandler);
    ws.close(1011, 'Invalid key');
    return;
  }

  const keyBytes = hexToBytes(keyHex);
  const upstreamHost = env.UPSTREAM_HOST || '127.0.0.1';

  const keyPtr = wasm.arenaMalloc(keyBytes.length);
  if (!keyPtr) {
    ws.removeEventListener('message', tempHandler);
    ws.close(1011, 'Memory error');
    return;
  }

  try {
    const memory = new Uint8Array(wasm.memory.buffer);
    memory.set(keyBytes, keyPtr);

    const cipherType = getCipherType(env.CIPHER_METHOD || 'aes-128-gcm');
    const layoutType = getLayoutType(env.LAYOUT_MODE || 'ascii');

    const sessionId = wasm.initSession(keyPtr, keyBytes.length, cipherType, layoutType);
    if (sessionId < 0) {
      ws.removeEventListener('message', tempHandler);
      ws.close(1011, `Init failed: ${sessionId}`);
      return;
    }

    const aead = new SudokuAEAD(wasm, sessionId, keyBytes);

    console.log('[Sudoku] Starting handshake...');
    console.log(`[Sudoku] Buffered messages: ${messageBuffer.length}`);
    
    const handshake = await handleSudokuHandshake(ws, aead, 10000, messageBuffer);

    if (!handshake.success) {
      console.error(`[Sudoku] Handshake failed: ${handshake.error}`);
      ws.removeEventListener('message', tempHandler);
      wasm.closeSession(sessionId);
      wasm.arenaFree(keyPtr);
      ws.close(1011, handshake.error || 'Handshake failed');
      return;
    }

    console.log('[Sudoku] Handshake successful, connecting upstream...');

    let upstreamSocket: Socket;
    try {
      upstreamSocket = connect({ hostname: upstreamHost, port: 443 });
      console.log('[Sudoku] Upstream connected');
    } catch (err) {
      wasm.closeSession(sessionId);
      wasm.arenaFree(keyPtr);
      ws.close(1011, 'Connect failed');
      return;
    }

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
        const plaintext = await aead.unmaskAndDecrypt(new Uint8Array(data));
        await upstreamSocket.write(plaintext);
      } catch (err) {
        console.error('[Sudoku] Decrypt error:', err);
        cleanup();
      }
    });

    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);

    const reader = upstreamSocket.readable.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          ws.close(1000, 'Upstream closed');
          break;
        }
        const masked = await aead.encryptAndMask(value);
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
