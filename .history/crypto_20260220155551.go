// AEAD 加密 - 从 golang.org/x/crypto 和 Go 标准库移植
// 官方源码:
// - https://github.com/golang/crypto/tree/master/chacha20poly1305
// - https://github.com/golang/crypto/tree/master/chacha20
// - https://github.com/golang/crypto/tree/master/internal/poly1305
//
// 移植规则:
// 1. 移除所有 slice 分配，使用固定数组+长度
// 2. 保持算法位级等价
// 3. ChaCha20-Poly1305 完整移植
// 4. AES-GCM 建议使用 Worker 侧 Web Crypto API (或完整移植 GHASH)

package main

import "unsafe"

// 加密类型常量
const (
	CipherNone         = 0
	CipherAES128GCM    = 1
	CipherChaCha20Poly = 2
)

// aeadEncrypt - AEAD 加密入口
// 参数:
//   id: session ID
//   plaintextPtr: 明文数据指针 (arena 中)
//   plaintextLen: 明文长度
//   outPtr: 输出缓冲区指针 (arena 中)
// 返回: 输出总长度 (0 表示失败)
//
// 输出格式:
//   ChaCha20-Poly1305: [ciphertext (len=plaintextLen)][tag (16 bytes)]
//   总长度 = plaintextLen + 16
//
//export aeadEncrypt
func aeadEncrypt(id int32, plaintextPtr uint32, plaintextLen uint32, outPtr uint32) uint32 {
	if id < 0 || id >= maxSessions || sessionUsed[id] == 0 {
		return 0
	}
	
	if plaintextLen == 0 {
		return 0
	}
	
	sessionAddr := sessionBase + uint32(id)*sessionSize
	session := (*SudokuInstance)(unsafe.Pointer(&arena[sessionAddr]))
	
	if session.cipherType == CipherNone {
		// 无加密，直接复制
		for i := uint32(0); i < plaintextLen; i++ {
			arena[outPtr+i] = arena[plaintextPtr+i]
		}
		return plaintextLen
	}
	
	// 生成 nonce
	var nonce [12]byte
	incNonce(session, nonce[:])
	
	switch session.cipherType {
	case CipherChaCha20Poly:
		return aeadEncryptChaCha20Poly1305(session, plaintextPtr, plaintextLen, &nonce, outPtr)
	case CipherAES128GCM:
		// AES-GCM 建议使用 Worker 侧 Web Crypto API
		// 如需 Wasm 内实现，需要完整的 GHASH 移植
		return 0
	default:
		return 0
	}
}

// aeadDecrypt - AEAD 解密入口
//export aeadDecrypt
func aeadDecrypt(id int32, ciphertextPtr uint32, ciphertextLen uint32, outPtr uint32) uint32 {
	if id < 0 || id >= maxSessions || sessionUsed[id] == 0 {
		return 0
	}
	
	if ciphertextLen == 0 {
		return 0
	}
	
	sessionAddr := sessionBase + uint32(id)*sessionSize
	session := (*SudokuInstance)(unsafe.Pointer(&arena[sessionAddr]))
	
	if session.cipherType == CipherNone {
		// 无加密，直接复制
		for i := uint32(0); i < ciphertextLen; i++ {
			arena[outPtr+i] = arena[ciphertextPtr+i]
		}
		return ciphertextLen
	}
	
	switch session.cipherType {
	case CipherChaCha20Poly:
		return aeadDecryptChaCha20Poly1305(session, ciphertextPtr, ciphertextLen, outPtr)
	case CipherAES128GCM:
		return 0
	default:
		return 0
	}
}

// aeadEncryptChaCha20Poly1305 - ChaCha20-Poly1305 加密
// 使用从 golang.org/x/crypto/chacha20poly1305 移植的实现
func aeadEncryptChaCha20Poly1305(
	session *SudokuInstance,
	plaintextPtr uint32,
	plaintextLen uint32,
	nonce *[12]byte,
	outPtr uint32,
) uint32 {
	// 限制最大明文长度 (2^38 - 64 字节，RFC 8439)
	if plaintextLen > ((1 << 38) - 64) {
		return 0
	}
	
	// 使用 arena 作为临时缓冲区
	// 注意: 这里假设 plaintext 和 out 不重叠
	plaintext := arena[plaintextPtr : plaintextPtr+plaintextLen]
	out := arena[outPtr : outPtr+plaintextLen+16]
	
	resultLen := chacha20poly1305Seal(
		&session.key,
		nonce,
		plaintext,
		int(plaintextLen),
		nil, // additional data
		0,
		out,
	)
	
	if resultLen == 0 {
		return 0
	}
	
	return uint32(resultLen)
}

// aeadDecryptChaCha20Poly1305 - ChaCha20-Poly1305 解密
func aeadDecryptChaCha20Poly1305(
	session *SudokuInstance,
	ciphertextPtr uint32,
	ciphertextLen uint32,
	outPtr uint32,
) uint32 {
	if ciphertextLen < 16 {
		return 0
	}
	
	// 提取 nonce (前 12 字节)
	var nonce [12]byte
	copy(nonce[:], arena[ciphertextPtr:ciphertextPtr+12])
	
	// 密文+标签 (不含 nonce)
	ctStart := ciphertextPtr + 12
	ctLen := ciphertextLen - 12
	ciphertextAndTag := arena[ctStart : ctStart+ctLen]
	out := arena[outPtr : outPtr+ctLen]
	
	plaintextLen := chacha20poly1305Open(
		&session.key,
		&nonce,
		ciphertextAndTag,
		int(ctLen),
		nil,
		0,
		out,
	)
	
	if plaintextLen < 0 {
		return 0 // 验证失败
	}
	
	return uint32(plaintextLen)
}

// incNonce - Nonce 大端序递增
// 关键: 必须与官方实现位级等价
func incNonce(session *SudokuInstance, nonce []byte) {
	// 递增 64-bit counter (大端序存储)
	session.nonceCounter++
	
	// 构造 12-byte nonce:
	// 前 4 字节: 固定值 (key 派生或随机)
	// 后 8 字节: counter (大端序)
	if len(nonce) >= 12 {
		// 使用 key 的前 4 字节作为 salt (与官方行为一致)
		nonce[0] = session.key[0]
		nonce[1] = session.key[1]
		nonce[2] = session.key[2]
		nonce[3] = session.key[3]
		
		// 后 8 字节: counter (大端序)
		// 注意: Wasm 是小端序，必须显式使用 BigEndian
		nonce[4] = byte(session.nonceCounter >> 56)
		nonce[5] = byte(session.nonceCounter >> 48)
		nonce[6] = byte(session.nonceCounter >> 40)
		nonce[7] = byte(session.nonceCounter >> 32)
		nonce[8] = byte(session.nonceCounter >> 24)
		nonce[9] = byte(session.nonceCounter >> 16)
		nonce[10] = byte(session.nonceCounter >> 8)
		nonce[11] = byte(session.nonceCounter)
	}
}
