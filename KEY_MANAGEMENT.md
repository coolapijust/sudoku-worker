# Sudoku Worker 密钥管理指南

## 密钥类型总览

| 密钥类型 | 用途 | 存储方式 | 环境变量名 |
|---------|------|---------|-----------|
| AEAD 对称密钥 | 数据加密 (ChaCha20/AES) | Secret | `SUDOKU_KEY` |
| Ed25519 私钥 | 身份签名 | Secret | `ED25519_PRIVATE_KEY` |
| Ed25519 公钥 | 身份验证 | 普通变量 | `ED25519_PUBLIC_KEY` |

## 1. AEAD 对称密钥

用于 WebSocket 数据流的加密/解密。

```bash
# 生成随机密钥 (32字节，hex编码)
openssl rand -hex 32
# 输出: a3f7b2d8e9c1a4f5b6d8e2c4a7f9b1d3e5c7a9b2d4f6e8c1a3b5d7f9e2c4a6

# 设置为 Secret (加密存储)
wrangler secret put SUDOKU_KEY
# 输入: a3f7b2d8e9c1a4f5b6d8e2c4a7f9b1d3e5c7a9b2d4f6e8c1a3b5d7f9e2c4a6
```

## 2. Ed25519 非对称密钥对

用于 Worker 身份验证（如与上游服务器建立信任）。

### 生成密钥对

```bash
# 方式1: 使用官方 Sudoku 客户端生成
go run cmd/keygen/main.go

# 方式2: 使用 OpenSSL (Ed25519)
openssl genpkey -algorithm Ed25519 -out ed25519.pem
openssl pkey -in ed25519.pem -pubout -out ed25519.pub.pem

# 转换为 hex (32字节私钥，64字节公钥)
# 私钥
openssl pkey -in ed25519.pem -outform DER | tail -c 32 | xxd -p -c 64

# 公钥  
openssl pkey -in ed25519.pub.pem -pubin -outform DER | tail -c 32 | xxd -p -c 64
```

### 配置到 Worker

```bash
# 私钥 - 使用 Secret (加密存储，不泄露)
wrangler secret put ED25519_PRIVATE_KEY
# 输入: d4ee72dbf913584ad5b6d8f67f8c3e3a7d9e5f1b2c4a6e8d0f2b4c6e8d0f2a4c6...

# 公钥 - 普通环境变量 (可以公开)
# 在 wrangler.toml 中直接配置
```

## 3. wrangler.toml 完整配置

```toml
name = "sudoku-wasm-bridge"
main = "dist/index.js"
compatibility_date = "2024-01-01"

[vars]
# 上游服务器
UPSTREAM_HOST = "127.0.0.1"
UPSTREAM_PORT = "8080"

# 加密方法: "none", "aes-128-gcm", "chacha20-poly1305"
CIPHER_METHOD = "chacha20-poly1305"

# Ed25519 公钥 (hex编码，64字符)
# 用于向客户端/上游证明 Worker 身份
ED25519_PUBLIC_KEY = "a3b5c7d9e1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a2c4e6d8f0a2c4e"

# 可选: 密钥派生盐值
KEY_DERIVE_SALT = "sudoku-v2-salt"

# Secrets (敏感信息，通过 wrangler secret put 设置)
# - SUDOKU_KEY: AEAD 对称密钥
# - ED25519_PRIVATE_KEY: Ed25519 私钥 (32字节 hex)
```

## 4. Worker 中的密钥使用

```typescript
interface Env {
  // 普通环境变量
  UPSTREAM_HOST: string;
  UPSTREAM_PORT: string;
  CIPHER_METHOD: string;
  ED25519_PUBLIC_KEY: string;  // 公钥 (可公开)
  KEY_DERIVE_SALT?: string;
  
  // Secrets (加密存储)
  SUDOKU_KEY: string;           // AEAD 对称密钥
  ED25519_PRIVATE_KEY?: string; // Ed25519 私钥 (用于签名)
  
  SUDOKU_WASM: WebAssembly.Module;
}
```

## 5. 密钥派生 (增强安全性)

如果 `SUDOKU_KEY` 是用户密码而非随机密钥，使用 PBKDF2 派生：

```typescript
async function deriveKeyFromPassword(password: string, salt: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);
  const saltBuffer = encoder.encode(salt);
  
  // PBKDF2 派生 32 字节密钥
  const keyMaterial = await crypto.subtle.importKey(
    'raw', passwordBuffer, 'PBKDF2', false, ['deriveBits']
  );
  
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  
  return new Uint8Array(derived);
}
```

## 6. Ed25519 签名验证 (示例)

```typescript
// 使用 noble-ed25519 库 (纯 JS，适合 Worker)
import * as ed from '@noble/ed25519';

class IdentityManager {
  private privateKey?: Uint8Array;
  private publicKey: Uint8Array;
  
  constructor(env: Env) {
    // 加载公钥 (必须)
    this.publicKey = hexToBytes(env.ED25519_PUBLIC_KEY);
    
    // 加载私钥 (仅当需要签名时)
    if (env.ED25519_PRIVATE_KEY) {
      this.privateKey = hexToBytes(env.ED25519_PRIVATE_KEY);
    }
  }
  
  // 签名挑战 (证明身份)
  async signChallenge(challenge: Uint8Array): Promise<Uint8Array> {
    if (!this.privateKey) {
      throw new Error('Private key not configured');
    }
    return ed.sign(challenge, this.privateKey);
  }
  
  // 验证上游服务器响应
  async verifyResponse(response: Uint8Array, signature: Uint8Array): Promise<boolean> {
    return ed.verify(signature, response, this.publicKey);
  }
}
```

## 7. 安全最佳实践

### ✅ 应该做的

1. **私钥用 Secret**: `wrangler secret put`，永不硬编码
2. **公钥用 Vars**: 可在 wrangler.toml 直接配置
3. **定期轮换**: 建议每 90 天轮换一次密钥
4. **最小权限**: Worker 只存储必要的密钥
5. **派生密钥**: 用户密码通过 PBKDF2/Argon2 派生

### ❌ 不应该做的

1. 不要把私钥提交到 Git
2. 不要把密钥写在 wrangler.toml 的 `[vars]` 中
3. 不要在日志中输出密钥
4. 不要在前端暴露任何密钥

## 8. 密钥轮换流程

```bash
# 1. 生成新密钥
openssl rand -hex 32 > new_key.txt

# 2. 更新 Secret
wrangler secret put SUDOKU_KEY < new_key.txt

# 3. 重启 Worker (自动)

# 4. 验证连接
# ... 测试 WebSocket 连接 ...

# 5. 删除旧密钥文件
shred -u new_key.txt
```

## 9. 多环境配置

```toml
# wrangler.toml

# 开发环境
[env.dev.vars]
UPSTREAM_HOST = "localhost"
UPSTREAM_PORT = "8080"
CIPHER_METHOD = "none"
ED25519_PUBLIC_KEY = "dev-pubkey-hex..."

# 生产环境
[env.production.vars]
UPSTREAM_HOST = "upstream.example.com"
UPSTREAM_PORT = "443"
CIPHER_METHOD = "chacha20-poly1305"
ED25519_PUBLIC_KEY = "prod-pubkey-hex..."
```

```bash
# 为不同环境设置密钥
wrangler secret put SUDOKU_KEY --env dev
wrangler secret put SUDOKU_KEY --env production
wrangler secret put ED25519_PRIVATE_KEY --env production
```
