/**
 * Sudoku AEAD 加密模块
 */

export class SudokuAEAD {
  constructor(
    private wasm: any,
    private sessionId: number,
    private key: Uint8Array
  ) { }

  async encryptAndMask(plaintext: Uint8Array): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await crypto.subtle.importKey(
      'raw', this.key.slice(0, 16), 'AES-GCM', false, ['encrypt']
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, cryptoKey, plaintext
    );
    const encrypted = new Uint8Array(iv.length + ciphertext.byteLength);
    encrypted.set(iv);
    encrypted.set(new Uint8Array(ciphertext), iv.length);
    return this.maskData(encrypted);
  }

  async unmaskAndDecrypt(data: Uint8Array): Promise<Uint8Array> {
    const unmasked = this.unmaskData(data);
    if (unmasked.length < 12) {
      throw new Error('Invalid data length for decryption');
    }
    const iv = unmasked.slice(0, 12);
    const ciphertext = unmasked.slice(12);
    const cryptoKey = await crypto.subtle.importKey(
      'raw', this.key.slice(0, 16), 'AES-GCM', false, ['decrypt']
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, cryptoKey, ciphertext
    );
    return new Uint8Array(plaintext);
  }

  // 简化的 encrypt/decrypt 方法（用于 poll-handler）
  encrypt(data: Uint8Array): Uint8Array | null {
    try {
      // 1. AEAD 加密
      const inPtr = this.wasm.arenaMalloc(data.length);
      const outPtr = this.wasm.arenaMalloc(data.length + 16); // AEAD overhead
      if (!inPtr || !outPtr) return null;

      const memory = new Uint8Array(this.wasm.memory.buffer);
      memory.set(data, inPtr);

      const resultLen = this.wasm.aeadEncrypt(this.sessionId, inPtr, data.length, outPtr);
      if (resultLen === 0) {
        this.wasm.arenaFree(inPtr);
        this.wasm.arenaFree(outPtr);
        return null;
      }

      const ciphertext = new Uint8Array(this.wasm.memory.buffer, outPtr, resultLen).slice();

      this.wasm.arenaFree(inPtr);
      this.wasm.arenaFree(outPtr);

      // 2. Sudoku 混淆 (Masking)
      return this.maskData(ciphertext);
    } catch (e) {
      console.error('[AEAD] Encrypt error:', e);
      return null;
    }
  }


  decrypt(data: Uint8Array): Uint8Array | null {
    try {
      // 1. Sudoku 去混淆 (Unmasking)
      const unmasked = this.unmaskData(data);
      if (unmasked.length === 0) return null;

      // 2. AEAD 解密
      const inPtr = this.wasm.arenaMalloc(unmasked.length);
      const outPtr = this.wasm.arenaMalloc(unmasked.length);
      if (!inPtr || !outPtr) return null;

      const memory = new Uint8Array(this.wasm.memory.buffer);
      memory.set(unmasked, inPtr);

      const resultLen = this.wasm.aeadDecrypt(this.sessionId, inPtr, unmasked.length, outPtr);
      if (resultLen === 0) {
        this.wasm.arenaFree(inPtr);
        this.wasm.arenaFree(outPtr);
        return null;
      }

      const result = new Uint8Array(this.wasm.memory.buffer, outPtr, resultLen).slice();

      this.wasm.arenaFree(inPtr);
      this.wasm.arenaFree(outPtr);
      return result;
    } catch (e) {
      console.error('[AEAD] Decrypt error:', e);
      return null;
    }
  }



  private maskData(data: Uint8Array): Uint8Array {
    const ptr = this.wasm.arenaMalloc(data.length);
    if (!ptr) throw new Error('Alloc failed');
    try {
      const memory = new Uint8Array(this.wasm.memory.buffer);
      memory.set(data, ptr);
      const outPtr = this.wasm.mask(this.sessionId, ptr, data.length);
      const outLen = this.wasm.getOutLen();
      const result = new Uint8Array(outLen);
      result.set(memory.subarray(outPtr, outPtr + outLen));
      return result;
    } finally {
      this.wasm.arenaFree(ptr);
    }
  }

  private unmaskData(data: Uint8Array): Uint8Array {
    const ptr = this.wasm.arenaMalloc(data.length);
    if (!ptr) throw new Error('Alloc failed');
    try {
      const memory = new Uint8Array(this.wasm.memory.buffer);
      memory.set(data, ptr);
      const outPtr = this.wasm.unmask(this.sessionId, ptr, data.length);
      const outLen = this.wasm.getOutLen();
      const result = new Uint8Array(outLen);
      result.set(memory.subarray(outPtr, outPtr + outLen));
      return result;
    } finally {
      this.wasm.arenaFree(ptr);
    }
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

export function getCipherType(method: string): number {
  const map: Record<string, number> = {
    'none': 0,
    'aes-128-gcm': 1,
    'chacha20-poly1305': 2,
    'aes-256-gcm': 3,
  };
  return map[method.toLowerCase()] ?? 2; // 默认使用 ChaCha20
}

export function getLayoutType(mode: string): number {
  const map: Record<string, number> = {
    'ascii': 0,
    'entropy': 1,
  };
  return map[mode.toLowerCase()] ?? 0;
}

