/**
 * Sudoku Protocol - Cloudflare Worker with TinyGo WASM
 * 
 * WASM Module Integration:
 * - Loads sudoku.wasm compiled from TinyGo
 * - Exports: arenaMalloc, arenaFree, initSession, closeSession, mask, unmask, etc.
 */

// WASM module instance
let wasmModule: WebAssembly.Module | null = null;
let wasmInstance: WebAssembly.Instance | null = null;
let wasmExports: any = null;

// WASM memory
let wasmMemory: WebAssembly.Memory | null = null;

/**
 * Initialize WASM module
 */
async function initWasm(): Promise<void> {
  if (wasmInstance) return;
  
  // Load WASM module from binding
  const wasmModuleBinding = (globalThis as any).SUDOKU_WASM;
  if (!wasmModuleBinding) {
    throw new Error('SUDOKU_WASM module not found. Check wrangler.toml configuration.');
  }
  
  // Instantiate WASM with memory
  wasmMemory = new WebAssembly.Memory({
    initial: 16,  // 1MB (16 * 64KB pages)
    maximum: 256  // 16MB max
  });
  
  const importObject = {
    env: {
      memory: wasmMemory,
    }
  };
  
  wasmInstance = await WebAssembly.instantiate(wasmModuleBinding, importObject);
  wasmExports = wasmInstance.exports;
  
  console.log('[WASM] Module initialized successfully');
}

/**
 * Get exported WASM functions
 */
function getWasmExports() {
  if (!wasmExports) {
    throw new Error('WASM not initialized');
  }
  return wasmExports;
}

/**
 * WASM wrapper functions
 */
export const sudokuWasm = {
  /**
   * Initialize the WASM module
   */
  async init(): Promise<void> {
    await initWasm();
  },

  /**
   * Allocate memory in WASM arena
   */
  arenaMalloc(size: number): number {
    return getWasmExports().arenaMalloc(size);
  },

  /**
   * Free memory in WASM arena
   */
  arenaFree(ptr: number): void {
    getWasmExports().arenaFree(ptr);
  },

  /**
   * Initialize a session
   */
  initSession(
    id: number,
    keyPtr: number,
    keyLen: number,
    cipherType: number,
    nonceSize: number,
    tagSize: number,
    layoutType: number,
    padPoolSize: number
  ): number {
    return getWasmExports().initSession(
      id, keyPtr, keyLen, cipherType, nonceSize, tagSize, layoutType, padPoolSize
    );
  },

  /**
   * Close a session
   */
  closeSession(id: number): void {
    getWasmExports().closeSession(id);
  },

  /**
   * Mask (encode) data
   */
  mask(id: number, inPtr: number, inLen: number): number {
    return getWasmExports().mask(id, inPtr, inLen);
  },

  /**
   * Unmask (decode) data
   */
  unmask(id: number, inPtr: number, inLen: number): number {
    return getWasmExports().unmask(id, inPtr, inLen);
  },

  /**
   * Get output length
   */
  getOutLen(): number {
    return getWasmExports().getOutLen();
  },

  /**
   * Get arena pointer
   */
  getArenaPtr(): number {
    return getWasmExports().getArenaPtr();
  },

  /**
   * Get session address
   */
  getSessionAddr(id: number): number {
    return getWasmExports().getSessionAddr(id);
  },

  /**
   * Get work buffer address
   */
  getWorkBuf(): number {
    return getWasmExports().getWorkBuf();
  },

  /**
   * Get output buffer address
   */
  getOutBuf(): number {
    return getWasmExports().getOutBuf();
  },

  /**
   * Get WASM memory buffer
   */
  getMemoryBuffer(): ArrayBuffer {
    if (!wasmMemory) {
      throw new Error('WASM memory not initialized');
    }
    return wasmMemory.buffer;
  },

  /**
   * Write data to WASM memory
   */
  writeToMemory(ptr: number, data: Uint8Array): void {
    const memory = new Uint8Array(this.getMemoryBuffer());
    memory.set(data, ptr);
  },

  /**
   * Read data from WASM memory
   */
  readFromMemory(ptr: number, len: number): Uint8Array {
    const memory = new Uint8Array(this.getMemoryBuffer());
    return memory.slice(ptr, ptr + len);
  }
};

// Export for use in other modules
export default sudokuWasm;
