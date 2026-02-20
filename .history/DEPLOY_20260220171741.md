# Cloudflare Worker 部署指南

## 前置条件

1. 安装 Wrangler CLI:
```bash
npm install -g wrangler
```

2. 登录 Cloudflare:
```bash
wrangler login
```

## 部署步骤

### 1. 配置 Secrets（敏感信息）

```bash
# 设置 AEAD 对称密钥 (32字节 hex = 64字符)
wrangler secret put SUDOKU_KEY

# 可选: 设置 Ed25519 私钥 (32字节 hex = 64字符)
wrangler secret put ED25519_PRIVATE_KEY
```

### 2. 部署到开发环境

```bash
wrangler deploy --env dev
```

### 3. 部署到生产环境

```bash
wrangler deploy --env production
```

## 验证部署

部署成功后，Worker 将可通过以下地址访问:
- 开发环境: `https://sudoku-wasm-bridge-dev.<your-subdomain>.workers.dev`
- 生产环境: `https://sudoku-wasm-bridge-prod.<your-subdomain>.workers.dev`

## 配置说明

### wrangler.toml 关键配置

- `name`: Worker 名称
- `main`: 入口文件路径
- `compatibility_date`: Cloudflare Workers 兼容性日期
- `[[wasm_modules]]`: WASM 模块绑定配置

### 环境变量

在 `wrangler.toml` 的 `[vars]` 部分配置:
- `UPSTREAM_HOST`: 上游服务器地址
- `UPSTREAM_PORT`: 上游服务器端口
- `CIPHER_METHOD`: 加密方法 (none/aes-128-gcm/chacha20-poly1305)
- `LAYOUT_MODE`: 布局模式 (ascii/entropy)
- `ED25519_PUBLIC_KEY`: Ed25519 公钥 (hex)
- `KEY_DERIVE_SALT`: 密钥派生盐值

### Secrets

通过 `wrangler secret put` 设置:
- `SUDOKU_KEY`: AEAD 对称密钥
- `ED25519_PRIVATE_KEY`: Ed25519 私钥 (可选)

## 故障排查

### WASM 模块未找到
确保 `sudoku.wasm` 文件存在于项目根目录，且 `wrangler.toml` 中的路径正确。

### 内存不足
如果 WASM 运行时内存不足，可以增加 `wasmMemory` 的 initial 值:
```typescript
wasmMemory = new WebAssembly.Memory({
  initial: 32,  // 2MB
  maximum: 512  // 32MB
});
```

### 导出函数未找到
确保 TinyGo 编译时使用了正确的导出标记 `//export`。
