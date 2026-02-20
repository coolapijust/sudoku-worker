/**
 * HTTP Tunnel 认证模块
 * 实现与原协议兼容的 HMAC 认证
 */

const TUNNEL_AUTH_HEADER_KEY = 'Authorization';
const TUNNEL_AUTH_HEADER_PREFIX = 'Bearer ';
const TUNNEL_AUTH_QUERY_KEY = 'auth';

export type TunnelMode = 'stream' | 'poll';

export class TunnelAuth {
  private keyHex: string;
  private keyPromise: Promise<Uint8Array> | null = null;
  private skew: number;

  constructor(keyHex: string, skew: number = 60) {
    this.keyHex = keyHex;
    this.skew = skew;
    this.keyPromise = this.initKey();
  }

  private async initKey(): Promise<Uint8Array> {
    const prefix = new TextEncoder().encode('sudoku-httpmask-auth-v1:');
    const keyBytes = hexToBytes(this.keyHex);
    
    const combined = new Uint8Array(prefix.length + keyBytes.length);
    combined.set(prefix);
    combined.set(keyBytes, prefix.length);
    
    const hash = await crypto.subtle.digest('SHA-256', combined);
    return new Uint8Array(hash);
  }

  private async getKey(): Promise<Uint8Array> {
    if (!this.keyPromise) {
      this.keyPromise = this.initKey();
    }
    return this.keyPromise;
  }

  async token(mode: TunnelMode, method: string, path: string, now: Date = new Date()): Promise<string> {
    const ts = Math.floor(now.getTime() / 1000);
    const key = await this.getKey();
    const sig = await this.sign(key, mode, method, path, ts);

    const buf = new Uint8Array(8 + 16);
    const view = new DataView(buf.buffer);
    view.setBigUint64(0, BigInt(ts), false);
    buf.set(sig, 8);

    return btoa(String.fromCharCode(...buf))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  async verify(
    authHeader: string | null,
    authQuery: string | null,
    mode: TunnelMode,
    method: string,
    path: string,
    now: Date = new Date()
  ): Promise<boolean> {
    let val = authHeader || authQuery;
    if (!val) return false;

    if (val.length > TUNNEL_AUTH_HEADER_PREFIX.length && 
        val.toLowerCase().startsWith(TUNNEL_AUTH_HEADER_PREFIX.toLowerCase())) {
      val = val.substring(TUNNEL_AUTH_HEADER_PREFIX.length).trim();
    }

    if (!val) return false;

    let raw: Uint8Array;
    try {
      const padding = 4 - (val.length % 4);
      if (padding !== 4) {
        val += '='.repeat(padding);
      }
      const binary = atob(val.replace(/-/g, '+').replace(/_/g, '/'));
      raw = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        raw[i] = binary.charCodeAt(i);
      }
    } catch (e) {
      return false;
    }

    if (raw.length !== 8 + 16) return false;

    const view = new DataView(raw.buffer);
    const ts = Number(view.getBigUint64(0, false));
    const nowTS = Math.floor(now.getTime() / 1000);
    const delta = Math.abs(nowTS - ts);

    if (delta > this.skew) {
      return false;
    }

    const key = await this.getKey();
    const want = await this.sign(key, mode, method, path, ts);
    
    if (raw.length - 8 !== want.length) return false;
    let result = 0;
    for (let i = 0; i < want.length; i++) {
      result |= raw[8 + i] ^ want[i];
    }
    return result === 0;
  }

  private async sign(
    key: Uint8Array,
    mode: TunnelMode,
    method: string,
    path: string,
    ts: number
  ): Promise<Uint8Array> {
    method = method.toUpperCase().trim() || 'GET';
    path = path.trim();

    const tsBuf = new Uint8Array(8);
    const view = new DataView(tsBuf.buffer);
    view.setBigUint64(0, BigInt(ts), false);

    const modeBytes = new TextEncoder().encode(mode);
    const methodBytes = new TextEncoder().encode(method);
    const pathBytes = new TextEncoder().encode(path);

    const message = new Uint8Array(
      modeBytes.length + 1 +
      methodBytes.length + 1 +
      pathBytes.length + 1 +
      tsBuf.length
    );

    let offset = 0;
    message.set(modeBytes, offset);
    offset += modeBytes.length;
    message[offset++] = 0;
    message.set(methodBytes, offset);
    offset += methodBytes.length;
    message[offset++] = 0;
    message.set(pathBytes, offset);
    offset += pathBytes.length;
    message[offset++] = 0;
    message.set(tsBuf, offset);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, message);
    
    return new Uint8Array(signature.slice(0, 16));
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

export function extractAuth(request: Request): { header: string | null; query: string | null } {
  const header = request.headers.get(TUNNEL_AUTH_HEADER_KEY);
  const url = new URL(request.url);
  const query = url.searchParams.get(TUNNEL_AUTH_QUERY_KEY);
  return { header, query };
}
