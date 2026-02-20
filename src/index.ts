/**
 * Sudoku Protocol - Cloudflare Worker
 * 支持 Poll 模式 HTTP Tunnel
 */

import { handleSession, handleStream, handleUpload, handleFin, handleClose } from './poll-handler';
import { SUDOKU_SITE_HTML } from './site';
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
    try {
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

      // Poll 模式端点 - 支持带 /api 前缀的路径
      switch (pathname) {
        case '/session':
        case '/api/session':
          return await handleSession(request, env, wasm);
        case '/stream':
        case '/api/stream':
          return await handleStream(request, env);
        case '/api/v1/upload':
          return await handleUpload(request, env);
        case '/fin':
        case '/api/fin':
          return await handleFin(request, env);
        case '/close':
        case '/api/close':
          return await handleClose(request, env, wasm);
        default:
          console.log(`[404] Fake site served: ${pathname}`);
          return new Response(SUDOKU_SITE_HTML, {
            status: 200,
            headers: { 'Content-Type': 'text/html;charset=UTF-8' },
          });
      }
    } catch (err: any) {
      console.error(`[Unhandled Error] ${err?.message || err}`);
      console.error(err?.stack || 'No stack trace');
      return new Response(`Internal Server Error: ${err?.message || err}`, { status: 500 });
    }
  }
};
