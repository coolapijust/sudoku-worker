/**
 * Ed25519 身份验证示例
 * 
 * 此文件展示如何在 Worker 中使用 Ed25519 密钥进行身份验证。
 * 实际使用时可以取消注释并集成到 index.ts
 */

// 需要安装 @noble/ed25519:
// npm install @noble/ed25519

// import * as ed from '@noble/ed25519';

/**
 * Ed25519 身份管理器
 * 
 * 用途:
 * 1. 证明 Worker 身份 (使用私钥签名)
 * 2. 验证上游服务器身份 (使用公钥验证)
 * 3. 安全密钥交换
 */
class Ed25519IdentityManager {
  private privateKey?: Uint8Array;
  private publicKey?: Uint8Array;
  
  constructor(env: { 
    ED25519_PUBLIC_KEY?: string; 
    ED25519_PRIVATE_KEY?: string;
  }) {
    // 加载公钥 (必须)
    if (env.ED25519_PUBLIC_KEY) {
      this.publicKey = this.hexToBytes(env.ED25519_PUBLIC_KEY);
      if (this.publicKey.length !== 32) {
        throw new Error('Ed25519 public key must be 32 bytes');
      }
    }
    
    // 加载私钥 (可选)
    if (env.ED25519_PRIVATE_KEY) {
      this.privateKey = this.hexToBytes(env.ED25519_PRIVATE_KEY);
      if (this.privateKey.length !== 32) {
        throw new Error('Ed25519 private key must be 32 bytes');
      }
    }
  }
  
  /**
   * 签名挑战 (证明 Worker 身份)
   * 当上游服务器要求验证时使用
   */
  async signChallenge(challenge: Uint8Array): Promise<Uint8Array> {
    if (!this.privateKey) {
      throw new Error('Ed25519 private key not configured (set ED25519_PRIVATE_KEY secret)');
    }
    // 使用 noble-ed25519 签名
    // return ed.sign(challenge, this.privateKey);
    throw new Error('Ed25519 library not installed. Run: npm install @noble/ed25519');
  }
  
  /**
   * 验证服务器响应
   * 验证上游服务器是否持有对应私钥
   */
  async verifyServerResponse(response: Uint8Array, signature: Uint8Array): Promise<boolean> {
    if (!this.publicKey) {
      throw new Error('Ed25519 public key not configured (set ED25519_PUBLIC_KEY variable)');
    }
    // 使用 noble-ed25519 验证
    // return ed.verify(signature, response, this.publicKey);
    throw new Error('Ed25519 library not installed. Run: npm install @noble/ed25519');
  }
  
  /**
   * 获取公钥 (用于向外界展示身份)
   */
  getPublicKey(): string | undefined {
    if (!this.publicKey) return undefined;
    return this.bytesToHex(this.publicKey);
  }
  
  /**
   * 生成密钥对 (辅助函数，用于首次设置)
   * 在本地运行，不要部署到 Worker
   */
  static async generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
    // const privateKey = ed.utils.randomPrivateKey();
    // const publicKey = await ed.getPublicKey(privateKey);
    // return {
    //   privateKey: this.prototype.bytesToHex(privateKey),
    //   publicKey: this.prototype.bytesToHex(publicKey)
    // };
    throw new Error('Run this locally with Ed25519 library installed');
  }
  
  private hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
  }
  
  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

/**
 * 使用示例
 * 
 * 1. 首次生成密钥对 (本地):
 *    const keys = await Ed25519IdentityManager.generateKeyPair();
 *    console.log('Public Key:', keys.publicKey);   // 设置到 wrangler.toml [vars]
 *    console.log('Private Key:', keys.privateKey); // 设置到 Secret
 * 
 * 2. Worker 中初始化:
 *    const identity = new Ed25519IdentityManager(env);
 * 
 * 3. 签名挑战:
 *    const challenge = crypto.getRandomValues(new Uint8Array(32));
 *    const signature = await identity.signChallenge(challenge);
 *    sendToServer(challenge, signature);
 * 
 * 4. 验证服务器:
 *    const isValid = await identity.verifyServerResponse(response, serverSignature);
 */

export { Ed25519IdentityManager };
