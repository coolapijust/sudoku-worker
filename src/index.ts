/**
 * Sudoku Protocol - Cloudflare Worker
 * 支持 Poll 模式 HTTP Tunnel
 */

import { handleSession, handleStream, handleUpload, handleFin, handleClose } from './poll-handler';

// WASM 模块通过 wrangler.toml 的 wasm_modules 配置绑定
// 在 Workers 环境中通过 env.SUDOKU_WASM 访问
declare global {
  interface Env {
    SUDOKU_WASM: WebAssembly.Module;
    SUDOKU_KEY: string;
    UPSTREAM_HOST: string;
    CIPHER_METHOD: string;
    LAYOUT_MODE: string;
  }
}

export interface Env {
  SUDOKU_WASM: WebAssembly.Module;
  SUDOKU_KEY: string;
  UPSTREAM_HOST: string;
  CIPHER_METHOD: string;
  LAYOUT_MODE: string;
}

let wasmInstanceCache: WebAssembly.Instance | null = null;
let wasmMemoryCache: WebAssembly.Memory | null = null;

export async function getWasmInstance(env: Env): Promise<WebAssembly.Instance> {
  if (wasmInstanceCache && wasmMemoryCache) {
    return wasmInstanceCache;
  }

  try {
    const wasmModule = env.SUDOKU_WASM;
    if (!wasmModule) {
      throw new Error('SUDOKU_WASM not found in environment');
    }

    const instantiated = await WebAssembly.instantiate(wasmModule, {
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

    // 获取 WASM 实例
    let wasm: any;
    try {
      const wasmInstance = await getWasmInstance(env);
      wasm = wasmInstance.exports;
    } catch (err) {
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
        return new Response('Not Found', { status: 404 });
    }
  }
};
