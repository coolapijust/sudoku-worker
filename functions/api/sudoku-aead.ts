/**
 * Sudoku AEAD 加密模块
 * 集成 AES-GCM 加密和 Sudoku mask/unmask
 */

export class SudokuAEAD {
  constructor(
    private wasm: any,
    private sessionId: number,
    private key: Uint8Array
  ) {}

  // 加密 + mask（服务器发送数据）
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

  // unmask + 解密（服务器接收数据）
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
    'chacha20-poly1305': 0,
    'aes-128-gcm': 1,
    'aes-256-gcm': 2,
  };
  return map[method.toLowerCase()] ?? 1;
}

export function getLayoutType(mode: string): number {
  const map: Record<string, number> = {
    'ascii': 0,
    'binary': 1,
  };
  return map[mode.toLowerCase()] ?? 0;
}
