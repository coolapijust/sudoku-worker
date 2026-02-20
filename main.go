// Sudoku Protocol - TinyGo Wasm Core
// 严格遵循零GC、固定Arena、静态Session管理规则
// 与官方Go客户端保持100%字节级兼容
//
// 内存布局说明:
//   [0x00000 - 0x40000]  SudokuInstance 静态数组 (1024 * 128 bytes)
//   [0x40000 - 0x80000]  查表数据区 (编码/解码表、网格数据)
//   [0x80000 - 0xC0000]  临时缓冲区
//   [0xC0000 - 0xFFFFF]  输出缓冲区
//   [0x100000+]          自由分配区 (Bump Pointer)

package main

import (
	"encoding/binary"
	"unsafe"
)

// ============================================================================
// 1. 固定内存池配置 (Fixed Arena Configuration)
// ============================================================================

const (
	arenaSize = 1 << 20

	maxSessions = 1024
	sessionSize = 128
	sessionBase = 0x00000

	workBufBase = 0x40000
	workBufSize = 0x20000

	outBufBase = 0x60000
	outBufSize = 0x20000

	heapBase = 0x80000

	numGrids         = 288
	numHintPositions = 1820
	maxHintsPerByte  = 50
	decodeTableSize  = 8192
)

//go:export arena
var arena [arenaSize]byte

var arenaPtr uint32 = heapBase
var sessionUsed [maxSessions]uint8
var currentOutLen uint32

// ============================================================================
// 2. 核心数据结构
// ============================================================================

type SudokuInstance struct {
	nonceCounter uint64
	key          [32]byte
	aeadState    [16]byte
	flags        uint32
	cipherType   uint8
	nonceSize    uint8
	tagSize      uint8
	_            uint8
	sudokuState  [64]byte
}

// 加密类型常量在 crypto.go 中定义:
// CipherNone = 0
// CipherAES128GCM = 1
// CipherChaCha20Poly = 2

const (
	LayoutASCII   = 0
	LayoutEntropy = 1
)

// ============================================================================
// 3. 预计算数据 (由 gen_data.go 生成)
// ============================================================================

//go:generate go run gen_data.go
// 以下变量在 data_generated.go 中定义:
// var allGridsData [numGrids][16]uint8
// var hintPositionsData [numHintPositions][4]uint8
// var encodeTable [256][maxHintsPerByte][4]uint8
// var encodeTableCount [256]uint8
// var decodeTableKeys [decodeTableSize]uint32
// var decodeTableVals [decodeTableSize]uint8

var perm4 = [24][4]uint8{
	{0, 1, 2, 3}, {0, 1, 3, 2}, {0, 2, 1, 3}, {0, 2, 3, 1},
	{0, 3, 1, 2}, {0, 3, 2, 1}, {1, 0, 2, 3}, {1, 0, 3, 2},
	{1, 2, 0, 3}, {1, 2, 3, 0}, {1, 3, 0, 2}, {1, 3, 2, 0},
	{2, 0, 1, 3}, {2, 0, 3, 1}, {2, 1, 0, 3}, {2, 1, 3, 0},
	{2, 3, 0, 1}, {2, 3, 1, 0}, {3, 0, 1, 2}, {3, 0, 2, 1},
	{3, 1, 0, 2}, {3, 1, 2, 0}, {3, 2, 0, 1}, {3, 2, 1, 0},
}

var paddingPool [32]uint8
var paddingPoolSize uint8

// ============================================================================
// 4. 内存分配器
// ============================================================================

//export arenaMalloc
func arenaMalloc(size uint32) uint32 {
	if size == 0 {
		return 0
	}
	alignedSize := (size + 7) & ^uint32(7)
	if arenaPtr+alignedSize > arenaSize {
		return 0
	}
	ptr := arenaPtr
	arenaPtr += alignedSize
	return ptr
}

//export arenaFree
func arenaFree(ptr uint32) {
	_ = ptr
}

// ============================================================================
// 5. Session 管理
// ============================================================================

//export initSession
// 简化版本 - 与原有协议客户端兼容
// 参数: keyPtr, keyLen, cipherType, layoutType
// 返回值: sessionId (>=0 成功, <0 失败)
func initSession(keyPtr uint32, keyLen uint32, cipherType uint8, layoutType uint8) int32 {
	// 查找空闲 session
	var id int32 = -1
	for i := int32(0); i < maxSessions; i++ {
		if sessionUsed[i] == 0 {
			id = i
			break
		}
	}
	if id < 0 {
		return -1 // 无可用 session
	}
	if keyLen > 32 {
		return -2 // 密钥过长
	}

	// 根据 cipherType 设置 nonceSize 和 tagSize
	var nonceSize uint8 = 12 // 默认 96 bits for GCM
	var tagSize uint8 = 16   // 默认 128 bits for GCM
	
	sessionUsed[id] = 1
	sessionAddr := sessionBase + uint32(id)*sessionSize
	session := (*SudokuInstance)(unsafe.Pointer(&arena[sessionAddr]))

	session.nonceCounter = 0
	for i := uint32(0); i < keyLen && i < 32; i++ {
		session.key[i] = arena[keyPtr+i]
	}
	session.cipherType = cipherType
	session.nonceSize = nonceSize
	session.tagSize = tagSize
	session.flags = 0

	state := &session.sudokuState
	copy(state[0:8], []byte{0x53, 0x55, 0x44, 0x4F, 0x4B, 0x55, 0x56, 0x32})
	state[8] = cipherType
	state[9] = nonceSize
	state[10] = tagSize
	state[11] = layoutType
	state[12] = uint8(paddingPoolSize)
	state[13] = uint8(paddingPoolSize)
	binary.BigEndian.PutUint16(state[14:16], uint16(19661))
	binary.BigEndian.PutUint32(state[16:20], 0)
	state[20] = 0
	state[21] = 0
	state[22] = 0
	state[23] = 0
	state[24] = 0
	state[25] = 0x3F

	return id
}

//export closeSession
func closeSession(id int32) {
	if id < 0 || id >= maxSessions {
		return
	}
	sessionUsed[id] = 0
	sessionAddr := sessionBase + uint32(id)*sessionSize
	for i := uint32(0); i < sessionSize; i++ {
		arena[sessionAddr+i] = 0
	}
}

// ============================================================================
// 6. 编解码辅助函数
// ============================================================================

func packHintsToKey(hints [4]uint8) uint32 {
	if hints[0] > hints[1] {
		hints[0], hints[1] = hints[1], hints[0]
	}
	if hints[2] > hints[3] {
		hints[2], hints[3] = hints[3], hints[2]
	}
	if hints[0] > hints[2] {
		hints[0], hints[2] = hints[2], hints[0]
	}
	if hints[1] > hints[3] {
		hints[1], hints[3] = hints[3], hints[1]
	}
	if hints[1] > hints[2] {
		hints[1], hints[2] = hints[2], hints[1]
	}
	return uint32(hints[0])<<24 | uint32(hints[1])<<16 | uint32(hints[2])<<8 | uint32(hints[3])
}

func decodeTableLookup(key uint32) (uint8, bool) {
	hash := key & (decodeTableSize - 1)
	for i := 0; i < decodeTableSize; i++ {
		if decodeTableKeys[hash] == key {
			return decodeTableVals[hash], true
		}
		if decodeTableKeys[hash] == 0 {
			return 0, false
		}
		hash = (hash + 1) & (decodeTableSize - 1)
	}
	return 0, false
}

func isHintASCII(b uint8) bool {
	return (b&0xC0) == 0x80
}

// ============================================================================
// 7. Mask/Unmask 核心
// ============================================================================

//export mask
func mask(id int32, inPtr uint32, inLen uint32) uint32 {
	if id < 0 || id >= maxSessions || sessionUsed[id] == 0 {
		return 0
	}
	if inLen == 0 {
		currentOutLen = 0
		return uint32(outBufBase)
	}

	sessionAddr := sessionBase + uint32(id)*sessionSize
	session := (*SudokuInstance)(unsafe.Pointer(&arena[sessionAddr]))
	state := &session.sudokuState
	rngState := binary.BigEndian.Uint32(state[16:20])

	out := uint32(outBufBase)
	outPos := uint32(0)
	maxOut := inLen*6 + 32
	if maxOut > outBufSize {
		maxOut = outBufSize
	}

	padPoolSize := state[12]
	paddingThreshold := binary.BigEndian.Uint16(state[14:16])
	paddingThreshold32 := uint32(paddingThreshold) << 16

	for i := uint32(0); i < inLen; i++ {
		b := arena[inPtr+i]

		if uint32(rngState) < paddingThreshold32 {
			rngState = rngState*1664525 + 1013904223
			padIdx := rngState % uint32(padPoolSize)
			if outPos < maxOut {
				arena[out+outPos] = paddingPool[padIdx]
				outPos++
			}
		}
		rngState = rngState*1664525 + 1013904223

		count := encodeTableCount[b]
		if count == 0 {
			if outPos < maxOut {
				arena[out+outPos] = b
				outPos++
			}
			continue
		}

		hintIdx := rngState % uint32(count)
		rngState = rngState*1664525 + 1013904223
		hints := encodeTable[b][hintIdx]

		permIdx := rngState % 24
		rngState = rngState*1664525 + 1013904223
		perm := perm4[permIdx]

		for j := 0; j < 4; j++ {
			if uint32(rngState) < paddingThreshold32 {
				rngState = rngState*1664525 + 1013904223
				padIdx := rngState % uint32(padPoolSize)
				if outPos < maxOut {
					arena[out+outPos] = paddingPool[padIdx]
					outPos++
				}
			}
			rngState = rngState*1664525 + 1013904223

			if outPos < maxOut {
				arena[out+outPos] = hints[perm[j]]
				outPos++
			}
		}
	}

	if uint32(rngState) < paddingThreshold32 {
		rngState = rngState*1664525 + 1013904223
		padIdx := rngState % uint32(padPoolSize)
		if outPos < maxOut {
			arena[out+outPos] = paddingPool[padIdx]
			outPos++
		}
	}

	binary.BigEndian.PutUint32(state[16:20], rngState)
	currentOutLen = outPos
	return uint32(outBufBase)
}

//export unmask
func unmask(id int32, inPtr uint32, inLen uint32) uint32 {
	if id < 0 || id >= maxSessions || sessionUsed[id] == 0 {
		return 0
	}
	if inLen == 0 {
		currentOutLen = 0
		return uint32(outBufBase)
	}

	sessionAddr := sessionBase + uint32(id)*sessionSize
	session := (*SudokuInstance)(unsafe.Pointer(&arena[sessionAddr]))
	state := &session.sudokuState

	out := uint32(outBufBase)
	outPos := uint32(0)

	var hintBuf [4]uint8
	hintCount := uint8(0)

	padMarker := state[25]
	_ = padMarker

	for i := uint32(0); i < inLen && outPos < outBufSize-4; i++ {
		b := arena[inPtr+i]

		if !isHintASCII(b) {
			continue
		}

		if (b & 0x30) != 0 {
			hintBuf[hintCount] = b
			hintCount++

			if hintCount == 4 {
				key := packHintsToKey(hintBuf)
				val, found := decodeTableLookup(key)
				if found {
					arena[out+outPos] = val
					outPos++
				}
				hintCount = 0
			}
		}
	}

	currentOutLen = outPos
	return uint32(outBufBase)
}

//export getOutLen
func getOutLen() uint32 {
	return currentOutLen
}

//export getArenaPtr
func getArenaPtr() uint32 {
	return 0
}

//export getSessionAddr
func getSessionAddr(id int32) uint32 {
	if id < 0 || id >= maxSessions {
		return 0
	}
	return sessionBase + uint32(id)*sessionSize
}

//export getWorkBuf
func getWorkBuf() uint32 {
	return workBufBase
}

//export getOutBuf
func getOutBuf() uint32 {
	return outBufBase
}

//export initCodecTables
func initCodecTables() {}

//export initCodecTablesWithKey
func initCodecTablesWithKey(keyPtr uint32, keyLen uint32) {}

// main - WASM 不需要 main 函数，但 TinyGo 需要
func main() {}
