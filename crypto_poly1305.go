// Poly1305 - 从 golang.org/x/crypto/internal/poly1305 移植
// 官方源码: https://github.com/golang/crypto/blob/master/internal/poly1305/sum_generic.go
// 移植规则:
// 1. 使用固定数组，无 slice
// 2. 保持数学运算完全等价

package main

import (
	"encoding/binary"
	"math/bits"
)

const (
	poly1305TagSize = 16
)

// macState - Poly1305 状态
// 移植自 macState
type macState struct {
	h [3]uint64 // 累加器
	r [2]uint64 // 密钥 r 部分 (clamped)
	s [2]uint64 // 密钥 s 部分
}

// poly1305Context - Poly1305 上下文
type poly1305Context struct {
	state  macState
	buffer [poly1305TagSize]byte
	offset int
}

// rMask0, rMask1 - Poly1305 clamping mask
// 从官方源码移植
const (
	rMask0 = 0x0FFFFFFC0FFFFFFF
	rMask1 = 0x0FFFFFFC0FFFFFFC
)

// poly1305Init - 初始化 Poly1305
// 移植自 initialize
func poly1305Init(ctx *poly1305Context, key *[32]byte) {
	// r = little-endian key[0:16] & rMask
	ctx.state.r[0] = binary.LittleEndian.Uint64(key[0:8]) & rMask0
	ctx.state.r[1] = binary.LittleEndian.Uint64(key[8:16]) & rMask1
	
	// s = little-endian key[16:32]
	ctx.state.s[0] = binary.LittleEndian.Uint64(key[16:24])
	ctx.state.s[1] = binary.LittleEndian.Uint64(key[24:32])
	
	// 清零累加器
	ctx.state.h[0] = 0
	ctx.state.h[1] = 0
	ctx.state.h[2] = 0
	ctx.offset = 0
}

// uint128 - 128位整数 (用于乘法)
// 移植自 uint128
type uint128 struct {
	lo, hi uint64
}

// mul64 - 64位乘法
func mul64(a, b uint64) uint128 {
	hi, lo := bits.Mul64(a, b)
	return uint128{lo, hi}
}

// add128 - 128位加法
func add128(a, b uint128) uint128 {
	lo, c := bits.Add64(a.lo, b.lo, 0)
	hi, _ := bits.Add64(a.hi, b.hi, c)
	return uint128{lo, hi}
}

// shiftRightBy2 - 右移2位
func shiftRightBy2(a uint128) uint128 {
	a.lo = a.lo>>2 | (a.hi&3)<<62
	a.hi = a.hi >> 2
	return a
}

const maskLow2Bits = 0x3
const maskNotLow2Bits = ^uint64(0x3)

// poly1305UpdateBlock - 更新一个块
// 移植自 updateGeneric
func poly1305UpdateBlock(state *macState, msg []byte, isFinal bool) {
	h0, h1, h2 := state.h[0], state.h[1], state.h[2]
	r0, r1 := state.r[0], state.r[1]
	
	// h += m (消息块)
	var c uint64
	if !isFinal {
		h0, c = bits.Add64(h0, binary.LittleEndian.Uint64(msg[0:8]), 0)
		h1, c = bits.Add64(h1, binary.LittleEndian.Uint64(msg[8:16]), c)
		h2 += c + 1 // 添加 2^128
	} else {
		// 最后一个不完整块
		var buf [poly1305TagSize]byte
		copy(buf[:], msg)
		buf[len(msg)] = 1
		h0, c = bits.Add64(h0, binary.LittleEndian.Uint64(buf[0:8]), 0)
		h1, c = bits.Add64(h1, binary.LittleEndian.Uint64(buf[8:16]), c)
		h2 += c
	}
	
	// h *= r (伽罗瓦域乘法)
	// 使用 130 位模数: 2^130 - 5
	
	h0r0 := mul64(h0, r0)
	h1r0 := mul64(h1, r0)
	h2r0 := mul64(h2, r0)
	h0r1 := mul64(h0, r1)
	h1r1 := mul64(h1, r1)
	h2r1 := mul64(h2, r1)
	
	// h2r0 和 h2r1 不会溢出 (h2 <= 7, r0/r1 的高4位被清零)
	
	m0 := h0r0
	m1 := add128(h1r0, h0r1)
	m2 := add128(h2r0, h1r1)
	m3 := h2r1
	
	t0 := m0.lo
	t1, c := bits.Add64(m1.lo, m0.hi, 0)
	t2, c := bits.Add64(m2.lo, m1.hi, c)
	t3, _ := bits.Add64(m3.lo, m2.hi, c)
	
	// 模约简: c * 2^130 + n = c * 5 + n (mod 2^130 - 5)
	// 将结果在 2^130 处分割为 h 和 cc
	h0, h1, h2 = t0, t1, t2&maskLow2Bits
	cc := uint128{t2 & maskNotLow2Bits, t3}
	
	// h += cc * 4 (即 c * 4)
	h0, c = bits.Add64(h0, cc.lo, 0)
	h1, c = bits.Add64(h1, cc.hi, c)
	h2 += c
	
	// h += cc (即 c，因为 cc >> 2 = c)
	cc = shiftRightBy2(cc)
	h0, c = bits.Add64(h0, cc.lo, 0)
	h1, c = bits.Add64(h1, cc.hi, c)
	h2 += c
	
	state.h[0], state.h[1], state.h[2] = h0, h1, h2
}

// poly1305Update - 更新消息
// 移植自 Write
func poly1305Update(ctx *poly1305Context, data []byte, len int) {
	for len > 0 {
		n := poly1305TagSize - ctx.offset
		if n > len {
			n = len
		}
		copy(ctx.buffer[ctx.offset:], data[:n])
		ctx.offset += n
		data = data[n:]
		len -= n
		
		if ctx.offset == poly1305TagSize {
			poly1305UpdateBlock(&ctx.state, ctx.buffer[:], false)
			ctx.offset = 0
		}
	}
}

// poly1305Finalize - 最终化并输出标签
// 移植自 finalize (在 sum_generic.go 中)
func poly1305Finalize(ctx *poly1305Context, out *[poly1305TagSize]byte) {
	// 处理剩余字节
	if ctx.offset > 0 {
		poly1305UpdateBlock(&ctx.state, ctx.buffer[:ctx.offset], true)
	}
	
	state := ctx.state
	
	// 完全模约简
	// h = (h mod 2^130) + 5 * (h >> 130)
	// 如果 h >= 2^130 - 5，则 h -= 2^130 - 5
	
	// 计算 g = h + 5
	g0, c := bits.Add64(state.h[0], 5, 0)
	g1, c := bits.Add64(state.h[1], 0, c)
	g2 := state.h[2] + c
	
	// 如果 g2 的第2位被设置 (即 g >= 2^130)，则使用 g
	// 否则使用 h
	mask := uint64(int64(g2>>2) - 1) // 如果 g2 >= 4，则 mask = 0xFFFFFFFFFFFFFFFF
	
	g0 &= mask
	g1 &= mask
	g2 &= mask
	mask = ^mask
	
	h0 := (state.h[0] & mask) | g0
	h1 := (state.h[1] & mask) | g1
	
	// h += s
	h0, c = bits.Add64(h0, state.s[0], 0)
	h1, _ = bits.Add64(h1, state.s[1], c)
	
	// 输出小端序
	binary.LittleEndian.PutUint64(out[0:8], h0)
	binary.LittleEndian.PutUint64(out[8:16], h1)
}

// poly1305Sum - 计算认证标签
func poly1305Sum(out *[poly1305TagSize]byte, msg []byte, key *[32]byte) {
	var ctx poly1305Context
	poly1305Init(&ctx, key)
	poly1305Update(&ctx, msg, len(msg))
	poly1305Finalize(&ctx, out)
}

// poly1305Verify - 验证认证标签
func poly1305Verify(mac *[poly1305TagSize]byte, msg []byte, key *[32]byte) bool {
	var computed [poly1305TagSize]byte
	poly1305Sum(&computed, msg, key)
	
	// 常量时间比较
	var diff uint8
	for i := 0; i < poly1305TagSize; i++ {
		diff |= mac[i] ^ computed[i]
	}
	return diff == 0
}
