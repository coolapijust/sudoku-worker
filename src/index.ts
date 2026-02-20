/**
 * Sudoku Protocol - Cloudflare Worker
 * 支持 Poll 模式 HTTP Tunnel
 */

import { handleSession, handleStream, handleUpload, handleFin, handleClose } from './poll-handler';
import sudokuWasmModule from '../sudoku.wasm';

export interface Env {
  SUDOKU_KEY: string;
  UPSTREAM_HOST: string;
  CIPHER_METHOD: string;
  LAYOUT_MODE: string;
}

let wasmInstanceCache: WebAssembly.Instance | null = null;
let wasmMemoryCache: WebAssembly.Memory | null = null;

export async function getWasmInstance(): Promise<WebAssembly.Instance> {
  if (wasmInstanceCache && wasmMemoryCache) {
    return wasmInstanceCache;
  }

  try {
    const instantiated = await WebAssembly.instantiate(sudokuWasmModule, {
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
        abort: () => { throw new Error('Wasm abort'); }
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    console.log(`[DEBUG] ${request.method} ${pathname} from ${request.headers.get('user-agent') || 'unknown'}`);

    // 获取 WASM 实例
    let wasm: any;
    try {
      const wasmInstance = await getWasmInstance();
      wasm = wasmInstance.exports;
    } catch (err) {
      console.error(`[WASM Error] ${err}`);
      return new Response(`WASM Error: ${err}`, { status: 500 });
    }

    // Poll 模式端点
    switch (pathname) {
      case '/session':
        return handleSession(request, env, wasm);
      case '/stream':
        return handleStream(request, env);
      case '/api/v1/upload':
        return handleUpload(request, env);
      case '/fin':
        return handleFin(request, env);
      case '/close':
        return handleClose(request, env, wasm);
      default:
        console.log(`[404] Path not found: ${pathname}`);
        return new Response(`Not Found: ${pathname}`, { status: 404 });
    }
  }
};
