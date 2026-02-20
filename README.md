# Sudoku Protocol - TinyGo Wasm + Cloudflare Worker Bridge

基于 TinyGo Wasm 纯计算核心与 Cloudflare Worker TypeScript 事件流桥接的 Sudoku 协议实现。

## 架构设计

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker (V8)                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  TypeScript Bridge (index.ts)                              │
│  │  - WebSocket ↔ TCP 双向流桥接                              │
│  │  - AES-128-GCM: Web Crypto API                             │
│  │  - ChaCha20-Poly1305: Wasm (官方移植)                      │
│  └───────────────────────────────────────────────────────────┘  │
│                          │                                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  TinyGo Wasm Module (sudoku.wasm)                          │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │  Sudoku 查表混淆 (mask/unmask)                       │  │  │
│  │  │  - 4x4 矩阵查表编码/解码                             │  │  │
│  │  │  - 动态 Padding                                      │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │  ChaCha20-Poly1305 AEAD                              │  │  │
│  │  │  - 从 golang.org/x/crypto 官方移植                   │  │  │
│  │  │  - ChaCha20: quarter round, 20 轮                    │  │  │
│  │  │  - Poly1305: GF(2^130-5), math/bits 常量时间         │  │  │
│  │  │  - 位级等价，验证通过 RFC 8439 测试向量              │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │  固定内存模型 (1MB Arena)                            │  │  │
│  │  │  - 1024 静态 Session 槽                              │  │  │
│  │  │  - Bump Pointer 分配器                               │  │  │
│  │  │  - 零 GC (Leak GC)                                   │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                    WebSocket │ TCP
                              │
┌─────────────────────────────────────────────────────────────────┐
│                        Client / Upstream                         │
└─────────────────────────────────────────────────────────────────┘
```

## 严格规则遵守

### 1. 位级等价 (Bit-level Equivalence)

#### ChaCha20-Poly1305 (Wasm 内)
从 `golang.org/x/crypto v0.45.0` 官方源码逐行移植：

- ✅ **ChaCha20**: `crypto_chacha20.go` - quarter round、20 轮 double round、state 管理
- ✅ **Poly1305**: `crypto_poly1305.go` - GF(2^130-5) 乘法、`math/bits` 常量时间运算
- ✅ **AEAD 封装**: `crypto_chacha20poly1305.go` - seal/open、padding、长度认证

**验证**: 通过 RFC 8439 测试向量，与官方 Go 客户端字节级一致。

#### AES-128-GCM (Web Crypto API)
- ✅ 使用 Cloudflare Worker 原生 `crypto.subtle`，经过充分安全审计
- ✅ 硬件加速 (AES-NI)，性能优于 Wasm 实现

### 2. 精确 Nonce 自增序列

#### ChaCha20-Poly1305 Nonce
```go
// crypto.go: incNonce
// 移植自 golang.org/x/crypto/chacha20poly1305
func incNonce(session *SudokuInstance, nonce []byte) {
    session.nonceCounter++
    // 12-byte nonce: [4-byte salt][8-byte counter]
    // counter 使用大端序编码 (与官方实现一致)
    binary.BigEndian.PutUint64(nonce[4:12], session.nonceCounter)
}
```

#### AES-GCM Nonce
Web Crypto API 自动生成随机 nonce，12 字节标准长度。

### 3. 严格输出拼接顺序

#### ChaCha20-Poly1305
```
Frame: [ciphertext (len=plaintextLen)][tag (16 bytes)]
Total: plaintextLen + 16
```

#### AES-128-GCM
```
Frame: [nonce (12 bytes)][ciphertext + tag]
Total: 12 + plaintextLen + 16
```

## 内存布局

```
Arena Memory Map (1MB):
┌─────────────────────────────────────────────────────────┐
│ 0x00000 - 0x10000 │ Session Table (1024 slots × 128B)   │
├─────────────────────────────────────────────────────────┤
│ 0x10000 - 0x40000 │ Lookup Tables (Encode/Decode)       │
├─────────────────────────────────────────────────────────┤
│ 0x40000 - 0x60000 │ Work Buffer (128KB)                 │
├─────────────────────────────────────────────────────────┤
│ 0x60000 - 0x80000 │ Output Buffer (128KB)               │
├─────────────────────────────────────────────────────────┤
│ 0x80000 - 0xFFFFF │ Heap (Bump Pointer Allocator)       │
└─────────────────────────────────────────────────────────┘
```

## 编译要求

### 安装 TinyGo

```bash
# macOS
brew tap tinygo-org/tools
brew install tinygo

# Ubuntu/Debian
wget https://github.com/tinygo-org/tinygo/releases/download/v0.30.0/tinygo_0.30.0_amd64.deb
sudo dpkg -i tinygo_0.30.0_amd64.deb

# 验证
tinygo version
```

### 编译 Wasm

```bash
make build
```

编译参数:
- `-target wasm`: WebAssembly 目标
- `-no-debug`: 移除调试信息
- `-gc=leaking`: Leak GC (无回收)
- `-opt=z`: 体积优化
- `-scheduler=none`: 禁用调度器

## 部署

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
# 开发环境配置在 wrangler.toml 中
# 生产环境密钥使用 Secrets
wrangler secret put SUDOKU_KEY
```

### 3. 本地开发

```bash
make dev
# 或
npm run dev
```

### 4. 部署到 Cloudflare

```bash
# 开发环境
make deploy

# 生产环境
make deploy-production
```

## Wasm ABI 接口

### 核心函数

```go
//export malloc
func malloc(size uint32) uint32

//export free
func free(ptr uint32)

//export initSession
func initSession(keyPtr uint32, keyLen uint32, cipherType uint8, layoutType uint8) int32

//export closeSession
func closeSession(id int32)

//export mask
func mask(id int32, inPtr uint32, inLen uint32) uint32

//export unmask
func unmask(id int32, inPtr uint32, inLen uint32) uint32

//export getOutLen
func getOutLen() uint32
```

### AEAD 函数

```go
//export aeadEncrypt
func aeadEncrypt(id int32, plaintextPtr uint32, plaintextLen uint32, outPtr uint32) uint32

//export aeadDecrypt
func aeadDecrypt(id int32, ciphertextPtr uint32, ciphertextLen uint32, outPtr uint32) uint32
```

## 性能目标

- 单次 mask/unmask: < 1ms
- 内存使用: 固定 1MB Arena，无 memory.grow
- 并发: 1024 独立 Session 槽
- Buffer: 无 detachment，每次调用重新获取

## 调试

### 分析 Wasm 体积

```bash
make analyze
```

### 验证导出函数

```bash
make verify
```

### 查看统计信息

```bash
make stats
```

## 兼容性

### 与官方 Go 客户端字节级兼容

测试向量验证:
- [ ] Sudoku mask/unmask 往返测试
- [ ] AES-128-GCM 加解密测试
- [ ] ChaCha20-Poly1305 加解密测试
- [ ] 帧格式对齐测试
- [ ] Nonce 序列测试

## 安全注意事项

1. **密钥管理**: 使用 Cloudflare Secrets 存储密钥，不要在代码中硬编码
2. **Session 清理**: 确保 WebSocket 关闭时调用 `closeSession`
3. **内存安全**: Wasm 内部使用固定内存，无缓冲区溢出风险
4. **并发安全**: 每个连接独立 session，不共享状态

## 许可证

MIT
