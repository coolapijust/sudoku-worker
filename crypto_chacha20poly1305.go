// ChaCha20-Poly1305 AEAD - 从 golang.org/x/crypto/chacha20poly1305 移植
// 官方源码: https://github.com/golang/crypto/blob/master/chacha20poly1305/chacha20poly1305_generic.go
// 移植规则:
// 1. 移除 slice 分配
// 2. 使用固定缓冲区
// 3. 保持算法流程完全等价

package main

import (
	"encoding/binary"
)

// chacha20poly1305Seal - 加密并认证
// 移植自 sealGeneric
// 输出格式: [ciphertext][tag (16 bytes)]
// 返回值: 输出总长度
func chacha20poly1305Seal(
	key *[32]byte,
	nonce *[12]byte,
	plaintext []byte,
	plaintextLen int,
	additionalData []byte,
	adLen int,
	out []byte,
) int {
	var c chacha20Cipher
	if !chacha20Init(&c, key[:], nonce[:]) {
		return 0
	}
	
	// 生成 Poly1305 密钥 (使用 counter=0)
	var polyKey [32]byte
	chacha20GenerateKey(&c, &polyKey)
	
	// 设置计数器为 1，跳过前 32 字节
	chacha20SetCounter(&c, 1)
	
	// 加密明文
	ciphertextLen := plaintextLen
	chacha20Xor(&c, out, plaintext, plaintextLen)
	
	// 计算 Poly1305 标签
	var ctx poly1305Context
	poly1305Init(&ctx, &polyKey)
	
	// 认证附加数据 (带填充)
	if adLen > 0 {
		poly1305Update(&ctx, additionalData, adLen)
		padLen := 16 - (adLen % 16)
		if padLen < 16 {
			var pad [16]byte
			poly1305Update(&ctx, pad[:], padLen)
		}
	}
	
	// 认证密文 (带填充)
	poly1305Update(&ctx, out, ciphertextLen)
	padLen := 16 - (ciphertextLen % 16)
	if padLen < 16 {
		var pad [16]byte
		poly1305Update(&ctx, pad[:], padLen)
	}
	
	// 认证长度 (小端序 8+8 字节)
	var lenBlock [16]byte
	binary.LittleEndian.PutUint64(lenBlock[0:8], uint64(adLen))
	binary.LittleEndian.PutUint64(lenBlock[8:16], uint64(plaintextLen))
	poly1305Update(&ctx, lenBlock[:], 16)
	
	// 输出标签到 out[ciphertextLen:]
	var tag [poly1305TagSize]byte
	poly1305Finalize(&ctx, &tag)
	copy(out[ciphertextLen:], tag[:])
	
	return ciphertextLen + poly1305TagSize
}

// chacha20poly1305Open - 解密并验证
// 移植自 openGeneric
// 输入格式: [ciphertext][tag (16 bytes)]
// 返回值: 明文长度，如果验证失败返回 -1
func chacha20poly1305Open(
	key *[32]byte,
	nonce *[12]byte,
	ciphertextAndTag []byte,
	ctLen int, // 包含标签的总长度
	additionalData []byte,
	adLen int,
	out []byte,
) int {
	if ctLen < poly1305TagSize {
		return -1
	}
	
	ciphertextLen := ctLen - poly1305TagSize
	tag := ciphertextAndTag[ciphertextLen:ctLen]
	ciphertext := ciphertextAndTag[:ciphertextLen]
	
	var c chacha20Cipher
	if !chacha20Init(&c, key[:], nonce[:]) {
		return -1
	}
	
	// 生成 Poly1305 密钥
	var polyKey [32]byte
	chacha20GenerateKey(&c, &polyKey)
	chacha20SetCounter(&c, 1)
	
	// 计算期望的标签
	var ctx poly1305Context
	poly1305Init(&ctx, &polyKey)
	
	// 认证附加数据
	if adLen > 0 {
		poly1305Update(&ctx, additionalData, adLen)
		padLen := 16 - (adLen % 16)
		if padLen < 16 {
			var pad [16]byte
			poly1305Update(&ctx, pad[:], padLen)
		}
	}
	
	// 认证密文
	poly1305Update(&ctx, ciphertext, ciphertextLen)
	padLen := 16 - (ciphertextLen % 16)
	if padLen < 16 {
		var pad [16]byte
		poly1305Update(&ctx, pad[:], padLen)
	}
	
	// 认证长度
	var lenBlock [16]byte
	binary.LittleEndian.PutUint64(lenBlock[0:8], uint64(adLen))
	binary.LittleEndian.PutUint64(lenBlock[8:16], uint64(ciphertextLen))
	poly1305Update(&ctx, lenBlock[:], 16)
	
	var expectedTag [poly1305TagSize]byte
	poly1305Finalize(&ctx, &expectedTag)
	
	// 常量时间验证标签
	var diff uint8
	for i := 0; i < poly1305TagSize; i++ {
		diff |= tag[i] ^ expectedTag[i]
	}
	if diff != 0 {
		// 验证失败，清零输出
		for i := 0; i < ciphertextLen; i++ {
			out[i] = 0
		}
		return -1
	}
	
	// 解密
	chacha20Xor(&c, out, ciphertext, ciphertextLen)
	
	return ciphertextLen
}
