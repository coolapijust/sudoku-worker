// ChaCha20 - 从 golang.org/x/crypto/chacha20 移植
// 官方源码: https://github.com/golang/crypto/blob/master/chacha20/chacha_generic.go
// 移植规则:
// 1. 移除所有 slice 操作，改为固定数组+指针
// 2. 移除堆分配
// 3. 保持算法完全等价

package main

import (
	"encoding/binary"
	"math/bits"
)

// ChaCha20 常量 "expand 32-byte k"
const (
	chachaKeySize   = 32
	chachaNonceSize = 12
	chachaBlockSize = 64
)

var chachaConstants = [4]uint32{0x61707865, 0x3320646e, 0x79622d32, 0x6b206574}

// chacha20Cipher 状态
type chacha20Cipher struct {
	key     [8]uint32
	counter uint32
	nonce   [3]uint32
	
	// 缓冲区
	buf  [chachaBlockSize]byte
	bufLen int
	
	// 预计算值
	precompDone    bool
	p1, p5, p9, p13 uint32
	p2, p6, p10, p14 uint32
	p3, p7, p11, p15 uint32
}

// quarterRound - ChaCha20 核心函数
// 从官方源码直接移植，保持完全等价
func chachaQuarterRound(a, b, c, d uint32) (uint32, uint32, uint32, uint32) {
	a += b
	d ^= a
	d = bits.RotateLeft32(d, 16)
	c += d
	b ^= c
	b = bits.RotateLeft32(b, 12)
	a += b
	d ^= a
	d = bits.RotateLeft32(d, 8)
	c += d
	b ^= c
	b = bits.RotateLeft32(b, 7)
	return a, b, c, d
}

// chacha20Init - 初始化 ChaCha20 状态
// 移植自 newUnauthenticatedCipher
func chacha20Init(c *chacha20Cipher, key []byte, nonce []byte) bool {
	if len(key) != chachaKeySize {
		return false
	}
	if len(nonce) != chachaNonceSize {
		return false
	}
	
	c.key[0] = binary.LittleEndian.Uint32(key[0:4])
	c.key[1] = binary.LittleEndian.Uint32(key[4:8])
	c.key[2] = binary.LittleEndian.Uint32(key[8:12])
	c.key[3] = binary.LittleEndian.Uint32(key[12:16])
	c.key[4] = binary.LittleEndian.Uint32(key[16:20])
	c.key[5] = binary.LittleEndian.Uint32(key[20:24])
	c.key[6] = binary.LittleEndian.Uint32(key[24:28])
	c.key[7] = binary.LittleEndian.Uint32(key[28:32])
	
	c.nonce[0] = binary.LittleEndian.Uint32(nonce[0:4])
	c.nonce[1] = binary.LittleEndian.Uint32(nonce[4:8])
	c.nonce[2] = binary.LittleEndian.Uint32(nonce[8:12])
	
	c.counter = 1 // 默认从1开始 (0用于生成poly1305密钥)
	c.bufLen = 0
	c.precompDone = false
	
	return true
}

// chacha20SetCounter - 设置计数器
// 移植自 SetCounter
func chacha20SetCounter(c *chacha20Cipher, counter uint32) {
	c.counter = counter
	c.bufLen = 0
	c.precompDone = false
}

// chacha20GenerateBlock - 生成一个 keystream 块到 buf
// 移植自 xorKeyStreamBlocksGeneric
func chacha20GenerateBlock(c *chacha20Cipher, out *[chachaBlockSize]byte) {
	// 初始化状态
	s0 := chachaConstants[0]
	s1 := chachaConstants[1]
	s2 := chachaConstants[2]
	s3 := chachaConstants[3]
	s4 := c.key[0]
	s5 := c.key[1]
	s6 := c.key[2]
	s7 := c.key[3]
	s8 := c.key[4]
	s9 := c.key[5]
	s10 := c.key[6]
	s11 := c.key[7]
	s12 := c.counter
	s13 := c.nonce[0]
	s14 := c.nonce[1]
	s15 := c.nonce[2]
	
	// 20轮 (10个双轮)
	for i := 0; i < 10; i++ {
		// 列轮
		s0, s4, s8, s12 = chachaQuarterRound(s0, s4, s8, s12)
		s1, s5, s9, s13 = chachaQuarterRound(s1, s5, s9, s13)
		s2, s6, s10, s14 = chachaQuarterRound(s2, s6, s10, s14)
		s3, s7, s11, s15 = chachaQuarterRound(s3, s7, s11, s15)
		// 对角轮
		s0, s5, s10, s15 = chachaQuarterRound(s0, s5, s10, s15)
		s1, s6, s11, s12 = chachaQuarterRound(s1, s6, s11, s12)
		s2, s7, s8, s13 = chachaQuarterRound(s2, s7, s8, s13)
		s3, s4, s9, s14 = chachaQuarterRound(s3, s4, s9, s14)
	}
	
	// 与初始状态相加并输出
	binary.LittleEndian.PutUint32(out[0:4], s0+chachaConstants[0])
	binary.LittleEndian.PutUint32(out[4:8], s1+chachaConstants[1])
	binary.LittleEndian.PutUint32(out[8:12], s2+chachaConstants[2])
	binary.LittleEndian.PutUint32(out[12:16], s3+chachaConstants[3])
	binary.LittleEndian.PutUint32(out[16:20], s4+c.key[0])
	binary.LittleEndian.PutUint32(out[20:24], s5+c.key[1])
	binary.LittleEndian.PutUint32(out[24:28], s6+c.key[2])
	binary.LittleEndian.PutUint32(out[28:32], s7+c.key[3])
	binary.LittleEndian.PutUint32(out[32:36], s8+c.key[4])
	binary.LittleEndian.PutUint32(out[36:40], s9+c.key[5])
	binary.LittleEndian.PutUint32(out[40:44], s10+c.key[6])
	binary.LittleEndian.PutUint32(out[44:48], s11+c.key[7])
	binary.LittleEndian.PutUint32(out[48:52], s12+c.counter)
	binary.LittleEndian.PutUint32(out[52:56], s13+c.nonce[0])
	binary.LittleEndian.PutUint32(out[56:60], s14+c.nonce[1])
	binary.LittleEndian.PutUint32(out[60:64], s15+c.nonce[2])
	
	c.counter++
}

// chacha20Xor - XOR 加密/解密
// 移植自 XORKeyStream
func chacha20Xor(c *chacha20Cipher, dst, src []byte, srcLen int) {
	if srcLen == 0 {
		return
	}
	
	// 首先使用缓冲区中的剩余密钥流
	if c.bufLen > 0 {
		keyStream := c.buf[chachaBlockSize-c.bufLen:]
		if srcLen < len(keyStream) {
			keyStream = keyStream[:srcLen]
		}
		for i := range keyStream {
			dst[i] = src[i] ^ keyStream[i]
		}
		c.bufLen -= len(keyStream)
		srcLen -= len(keyStream)
		if srcLen == 0 {
			return
		}
		dst = dst[len(keyStream):]
		src = src[len(keyStream):]
	}
	
	// 处理完整的块
	for srcLen >= chachaBlockSize {
		var block [chachaBlockSize]byte
		chacha20GenerateBlock(c, &block)
		for i := 0; i < chachaBlockSize; i++ {
			dst[i] = src[i] ^ block[i]
		}
		srcLen -= chachaBlockSize
		dst = dst[chachaBlockSize:]
		src = src[chachaBlockSize:]
	}
	
	// 处理剩余字节
	if srcLen > 0 {
		chacha20GenerateBlock(c, &c.buf)
		for i := 0; i < srcLen; i++ {
			dst[i] = src[i] ^ c.buf[i]
		}
		c.bufLen = chachaBlockSize - srcLen
	}
}

// chacha20GenerateKey - 使用 counter=0 生成 32 字节密钥 (用于 Poly1305)
func chacha20GenerateKey(c *chacha20Cipher, out *[32]byte) {
	// 保存当前计数器
	savedCounter := c.counter
	
	// 设置计数器为 0
	c.counter = 0
	
	// 生成一个块
	var block [chachaBlockSize]byte
	chacha20GenerateBlock(c, &block)
	
	// 复制前32字节
	copy(out[:], block[:32])
	
	// 恢复计数器为 1 (跳过前32字节)
	c.counter = 1
	
	// 恢复原始计数器+1 (因为 generateBlock 会递增)
	if savedCounter > 0 {
		c.counter = savedCounter
	}
}
