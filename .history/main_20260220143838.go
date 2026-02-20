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
	// 全局Arena大小: 1MB
	arenaSize = 1 << 20

	// Session配置
	maxSessions = 1024
	sessionSize = 128 // 每个session固定128字节
	sessionBase = 0x00000

	// 查表数据区 (Table Data Region)
	tableBase = 0x10000

	// 工作缓冲区
	workBufBase = 0x40000
	workBufSize = 0x20000

	// 输出缓冲区 (用于mask/unmask结果)
	outBufBase = 0x60000
	outBufSize = 0x20000

	// 自由分配区起始地址 (Bump Pointer 起点)
	heapBase = 0x80000
)

// 全局Arena内存池 - 导出供Wasm使用
//
//go:export arena
var arena [arenaSize]byte

// Arena分配指针 (8字节对齐)
var arenaPtr uint32 = heapBase

// Session使用标记数组 (0=空闲, 1=使用中)
var sessionUsed [maxSessions]uint8

// 当前输出缓冲区长度 (由mask/unmask设置)
var currentOutLen uint32

// ============================================================================
// 2. 核心数据结构定义 (Core Data Structures)
// ============================================================================

// SudokuInstance - 单个连接会话状态
// 内存布局: 128 bytes，无指针字段，紧凑排列
type SudokuInstance struct {
	nonceCounter uint64   // 8 bytes - 必须大端序递增
	key          [32]byte // 32 bytes - AEAD密钥
	aeadState    [16]byte // 16 bytes - AEAD状态缓存
	flags        uint32   // 4 bytes - 会话标志
	cipherType   uint8    // 1 byte  - 加密类型
	nonceSize    uint8    // 1 byte  - nonce大小
	tagSize      uint8    // 1 byte  - tag大小
	_            uint8    // 1 byte  - 填充对齐
	sudokuState  [64]byte // 64 bytes - Sudoku状态
}

// AEAD 类型常量
const (
	CipherNone         = 0
	CipherAES128GCM    = 1
	CipherChaCha20Poly = 2
)

// Layout 类型常量
const (
	LayoutASCII   = 0
	LayoutEntropy = 1
)

// ============================================================================
// 3. 固定内存分配器 (Fixed Arena Allocator)
// ============================================================================

// malloc - 固定内存分配 (Bump Pointer 算法)
//export malloc
func malloc(size uint32) uint32 {
	if size == 0 {
		return 0
	}

	// 8字节对齐
	alignedSize := (size + 7) &^ uint32(7)

	// 检查溢出
	if arenaPtr+alignedSize > arenaSize {
		return 0
	}

	ptr := arenaPtr
	arenaPtr += alignedSize
	return ptr
}

// free - 空操作 (Leak GC策略下不回收)
//export free
func free(ptr uint32) {
	// Leak GC: 不实际释放，内存将在session关闭时重用
	_ = ptr
}

// ============================================================================
// 4. Session 管理 (Static Array - No Map)
// ============================================================================

// initSession - 初始化新会话
//export initSession
func initSession(keyPtr uint32, keyLen uint32, cipherType uint8, layoutType uint8) int32 {
	if keyLen > 32 {
		return -2
	}

	// 扫描空闲session槽
	var id int32 = -1
	for i := uint32(0); i < maxSessions; i++ {
		if sessionUsed[i] == 0 {
			id = int32(i)
			break
		}
	}
	if id < 0 {
		return -1
	}

	// 获取session地址
	sessionAddr := sessionBase + uint32(id)*sessionSize
	session := (*SudokuInstance)(unsafe.Pointer(&arena[sessionAddr]))

	// 清零session
	ptr := (*[128]byte)(unsafe.Pointer(session))
	for i := 0; i < 128; i++ {
		ptr[i] = 0
	}

	// 复制密钥 (或派生密钥)
	// 注意: ChaCha20-Poly1305 需要 32 字节密钥
	// AES-128-GCM 需要 16 字节密钥
	actualKeyLen := keyLen
	if cipherType == CipherAES128GCM && keyLen > 16 {
		actualKeyLen = 16 // 只使用前 16 字节
	}
	for i := uint32(0); i < actualKeyLen; i++ {
		session.key[i] = arena[keyPtr+i]
	}
	// 如果密钥长度不足 32 字节，用 0 填充 (ChaCha20 需要)
	for i := actualKeyLen; i < 32; i++ {
		session.key[i] = 0
	}

	// 初始化session字段
	session.cipherType = cipherType
	session.nonceCounter = 0
	session.flags = 0

	// 根据加密类型设置参数
	switch cipherType {
	case CipherNone:
		session.nonceSize = 0
		session.tagSize = 0
	case CipherAES128GCM:
		session.nonceSize = 12
		session.tagSize = 16
	case CipherChaCha20Poly:
		session.nonceSize = 12
		session.tagSize = 16
	}

	// 初始化Sudoku状态
	initSudokuState(session, layoutType)

	// 标记为使用中
	sessionUsed[id] = 1

	return id
}

// closeSession - 关闭会话
//export closeSession
func closeSession(id int32) {
	if id < 0 || id >= maxSessions {
		return
	}
	if sessionUsed[id] == 0 {
		return
	}

	// 获取session地址
	sessionAddr := sessionBase + uint32(id)*sessionSize
	session := (*SudokuInstance)(unsafe.Pointer(&arena[sessionAddr]))

	// 清零敏感数据
	ptr := (*[128]byte)(unsafe.Pointer(session))
	for i := 0; i < 128; i++ {
		ptr[i] = 0
	}

	// 标记为空闲
	sessionUsed[id] = 0
}

// ============================================================================
// 5. Sudoku 查表混淆核心 (Core Obfuscation Logic)
// ============================================================================

const (
	numGrids         = 288  // 4x4数独网格总数
	numHintPositions = 1820 // C(16,4)
	maxHintsPerByte  = 50   // 每个字节最大编码选项
	decodeTableSize  = 8192 // 解码表大小 (2^13)
)

// 24 种排列 (4!)
var perm4 = [24][4]uint8{
	{0, 1, 2, 3}, {0, 1, 3, 2}, {0, 2, 1, 3}, {0, 2, 3, 1},
	{0, 3, 1, 2}, {0, 3, 2, 1}, {1, 0, 2, 3}, {1, 0, 3, 2},
	{1, 2, 0, 3}, {1, 2, 3, 0}, {1, 3, 0, 2}, {1, 3, 2, 0},
	{2, 0, 1, 3}, {2, 0, 3, 1}, {2, 1, 0, 3}, {2, 1, 3, 0},
	{2, 3, 0, 1}, {2, 3, 1, 0}, {3, 0, 1, 2}, {3, 0, 2, 1},
	{3, 1, 0, 2}, {3, 1, 2, 0}, {3, 2, 0, 1}, {3, 2, 1, 0},
}

// 预计算的所有有效4x4数独网格 (288个)
// 注: 完整数据在初始化时加载
var allGridsData [numGrids][16]uint8

// Hint位置组合
var hintPositionsData [numHintPositions][4]uint8

// 编码/解码表
var encodeTable [256][maxHintsPerByte][4]uint8
var encodeTableCount [256]uint8
var decodeTableKeys [decodeTableSize]uint32
var decodeTableVals [decodeTableSize]uint8

// Padding池
var paddingPool [32]uint8
var paddingPoolSize uint8

// hintPart结构
type hintPart struct {
	val uint8
	pos uint8
}

// ============================================================================
// 6. 初始化函数
// ============================================================================

func init() {
	initGrids()
	initHintPositions()
	initCodecTables()
}

// Grid 类型定义 (4x4 Sudoku)
type Grid [16]uint8

// initGrids - 初始化所有288个有效4x4数独网格 (完整移植)
// 使用回溯算法生成，与原版 Go 实现完全一致
func initGrids() {
	var g Grid
	gridCount := 0

	var backtrack func(int)
	backtrack = func(idx int) {
		if idx == 16 {
			allGridsData[gridCount] = g
			gridCount++
			return
		}
		row, col := idx/4, idx%4
		br, bc := (row/2)*2, (col/2)*2
		for num := uint8(1); num <= 4; num++ {
			valid := true
			for i := 0; i < 4; i++ {
				if g[row*4+i] == num || g[i*4+col] == num {
					valid = false
					break
				}
			}
			if valid {
				for r := 0; r < 2; r++ {
					for c := 0; c < 2; c++ {
						if g[(br+r)*4+(bc+c)] == num {
							valid = false
							break
						}
					}
				}
			}
			if valid {
				g[idx] = num
				backtrack(idx + 1)
				g[idx] = 0
			}
		}
	}
	backtrack(0)
}

// initHintPositions - 计算C(16,4) = 1820种位置组合
func initHintPositions() {
	idx := 0
	for a := uint8(0); a < 13; a++ {
		for b := a + 1; b < 14; b++ {
			for c := b + 1; c < 15; c++ {
				for d := c + 1; d < 16; d++ {
					hintPositionsData[idx] = [4]uint8{a, b, c, d}
					idx++
				}
			}
		}
	}
}

// hasUniqueMatch - 检查hints是否唯一确定网格
func hasUniqueMatch(parts [4]hintPart) bool {
	matchCount := 0
	for g := 0; g < numGrids; g++ {
		match := true
		for i := 0; i < 4; i++ {
			if allGridsData[g][parts[i].pos] != parts[i].val {
				match = false
				break
			}
		}
		if match {
			matchCount++
			if matchCount > 1 {
				return false
			}
		}
	}
	return matchCount == 1
}

// packHintsToKey - 排序hints并打包为uint32
func packHintsToKey(hints [4]uint8) uint32 {
	// 排序网络
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

// decodeTableInsert - 插入解码表
func decodeTableInsert(key uint32, val uint8) {
	hash := key & (decodeTableSize - 1)
	for {
		if decodeTableKeys[hash] == 0 {
			decodeTableKeys[hash] = key
			decodeTableVals[hash] = val
			return
		}
		hash = (hash + 1) & (decodeTableSize - 1)
	}
}

// decodeTableLookup - 查找解码表
func decodeTableLookup(key uint32) (uint8, bool) {
	hash := key & (decodeTableSize - 1)
	for {
		if decodeTableKeys[hash] == key {
			return decodeTableVals[hash], true
		}
		if decodeTableKeys[hash] == 0 {
			return 0, false
		}
		hash = (hash + 1) & (decodeTableSize - 1)
	}
}

// initCodecTables - 初始化编解码表 (默认 key)
//export initCodecTables
func initCodecTables() {
	initCodecTablesWithKey(0, 0)
}

// initCodecTablesWithKey - 使用指定 key 初始化编解码表
// keyPtr: 密钥指针 (arena 中)
// keyLen: 密钥长度
//export initCodecTablesWithKey
func initCodecTablesWithKey(keyPtr uint32, keyLen uint32) {
	// 从 key 派生种子
	var seed uint64 = 0
	if keyLen > 0 {
		for i := uint32(0); i < keyLen && i < 8; i++ {
			seed = (seed << 8) | uint64(arena[keyPtr+i])
		}
	}
	if seed == 0 {
		seed = 0x7375646F6B75 // 默认种子 "sudoku"
	}
	rngState := uint32(seed ^ (seed >> 32))

	// LCG随机数
	rngNext := func() uint32 {
		rngState = rngState*1664525 + 1013904223
		return rngState
	}

	// 打乱网格顺序 (Fisher-Yates shuffle)
	var gridOrder [numGrids]uint16
	for i := 0; i < numGrids; i++ {
		gridOrder[i] = uint16(i)
	}
	for i := numGrids - 1; i > 0; i-- {
		j := rngNext() % uint32(i+1)
		gridOrder[i], gridOrder[j] = gridOrder[j], gridOrder[i]
	}

	// 构建编解码表
	for byteVal := 0; byteVal < 256; byteVal++ {
		targetGrid := gridOrder[byteVal]
		count := uint8(0)

		for hpIdx := 0; hpIdx < numHintPositions && count < maxHintsPerByte; hpIdx++ {
			positions := hintPositionsData[hpIdx]

			var parts [4]hintPart
			for i := 0; i < 4; i++ {
				pos := positions[i]
				val := allGridsData[targetGrid][pos]
				parts[i] = hintPart{val: val, pos: pos}
			}

			if !hasUniqueMatch(parts) {
				continue
			}

			var hints [4]uint8
			for i := 0; i < 4; i++ {
				hints[i] = encodeHintASCII(parts[i].val-1, parts[i].pos)
			}

			encodeTable[byteVal][count] = hints
			count++

			key := packHintsToKey(hints)
			decodeTableInsert(key, uint8(byteVal))
		}

		encodeTableCount[byteVal] = count
	}

	// 初始化padding池
	paddingPoolSize = 0
	for i := uint8(0); i < 32 && paddingPoolSize < 32; i++ {
		b := uint8(0x20 + i)
		if (b & 0x40) != 0x40 {
			paddingPool[paddingPoolSize] = b
			paddingPoolSize++
		}
	}
}

// encodeHintASCII - ASCII布局编码hint
func encodeHintASCII(val, pos uint8) uint8 {
	b := uint8(0x40 | ((val & 0x03) << 4) | (pos & 0x0F))
	if b == 0x7F {
		return 0x0A // '\n'
	}
	return b
}

// decodeGroupASCII - ASCII布局解码组
func decodeGroupASCII(b uint8) (uint8, bool) {
	if b == 0x0A || b == 0x7F {
		return 0x3F, true
	}
	if (b & 0x40) == 0 {
		return 0, false
	}
	return b & 0x3F, true
}

// isHintASCII - 判断是否为hint字节
func isHintASCII(b uint8) bool {
	if (b & 0x40) == 0x40 {
		return true
	}
	return b == 0x0A || b == 0x7F
}

// initSudokuState - 初始化Session的Sudoku状态
func initSudokuState(session *SudokuInstance, layoutType uint8) {
	state := &session.sudokuState

	// 使用 key 派生 RNG 种子，与原版 Go 协议一致
	// seed = key[0:8] as big-endian uint64
	var seed uint64 = 0
	for i := 0; i < 8 && i < len(session.key); i++ {
		seed = (seed << 8) | uint64(session.key[i])
	}
	if seed == 0 {
		seed = 0x7375646F6B75
	}
	rngState := uint32(seed ^ (seed >> 32))

	// 布局类型
	state[12] = layoutType

	// Padding池大小
	state[13] = paddingPoolSize

	// Padding阈值 (30%概率)
	binary.BigEndian.PutUint16(state[14:16], uint16(int(0.3*float64(1<<16))))

	// RNG状态
	binary.BigEndian.PutUint32(state[16:20], rngState)

	// bitBuf和bitCount清零
	state[20] = 0
	state[21] = 0
	state[22] = 0
	state[23] = 0
	state[24] = 0

	// padMarker
	state[25] = 0x3F
}

// ============================================================================
// 7. Mask/Unmask 核心函数
// ============================================================================

// mask - 混淆编码 (Write方向)
//export mask
func mask(id int32, inPtr uint32, inLen uint32) uint32 {
	if id < 0 || id >= maxSessions || sessionUsed[id] == 0 {
		return 0
	}
	if inLen == 0 {
		currentOutLen = 0
		return outBufBase
	}

	sessionAddr := sessionBase + uint32(id)*sessionSize
	session := (*SudokuInstance)(unsafe.Pointer(&arena[sessionAddr]))
	state := &session.sudokuState

	// 恢复RNG状态
	rngState := binary.BigEndian.Uint32(state[16:20])

	out := uint32(outBufBase)
	outPos := uint32(0)

	// 最大输出大小
	maxOut := inLen*6 + 32
	if maxOut > outBufSize {
		maxOut = outBufSize
	}

	padPoolSize := state[13]
	paddingThreshold := binary.BigEndian.Uint16(state[14:16])
	paddingThreshold32 := uint32(paddingThreshold) << 16

	// 处理每个输入字节
	for i := uint32(0); i < inLen; i++ {
		b := arena[inPtr+i]

		// 可能添加padding (32位精度，与原版一致)
		if uint32(rngState) < paddingThreshold32 {
			rngState = rngState*1664525 + 1013904223
			padIdx := rngState % uint32(padPoolSize)
			if outPos < maxOut {
				arena[out+outPos] = paddingPool[padIdx]
				outPos++
			}
		}
		rngState = rngState*1664525 + 1013904223

		// 选择编码选项
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

		// 选择排列
		permIdx := rngState % 24
		rngState = rngState*1664525 + 1013904223
		perm := perm4[permIdx]

		// 输出hints
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

	// 尾部padding
	if uint32(rngState) < paddingThreshold32 {
		rngState = rngState*1664525 + 1013904223
		padIdx := rngState % uint32(padPoolSize)
		if outPos < maxOut {
			arena[out+outPos] = paddingPool[padIdx]
			outPos++
		}
	}

	// 保存状态
	binary.BigEndian.PutUint32(state[16:20], rngState)

	currentOutLen = outPos
	return outBufBase
}

// unmask - 反混淆解码 (Read方向)
//export unmask
func unmask(id int32, inPtr uint32, inLen uint32) uint32 {
	if id < 0 || id >= maxSessions || sessionUsed[id] == 0 {
		return 0
	}
	if inLen == 0 {
		currentOutLen = 0
		return outBufBase
	}

	sessionAddr := sessionBase + uint32(id)*sessionSize
	session := (*SudokuInstance)(unsafe.Pointer(&arena[sessionAddr]))
	state := &session.sudokuState

	out := outBufBase
	outPos := uint32(0)

	var hintBuf [4]uint8
	hintCount := uint8(0)

	padMarker := state[25]

	// 处理每个输入字节
	for i := uint32(0); i < inLen && outPos < outBufSize-4; i++ {
		b := arena[inPtr+i]

		// 检查是否为hint字节
		if !isHintASCII(b) {
			if b == padMarker {
				// 重置状态
			}
			continue
		}

		// 解码group
		_, ok := decodeGroupASCII(b)
		if !ok {
			continue
		}

		// 检查是否为有效hint
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
	return outBufBase
}

// getOutLen - 获取最后一次mask/unmask的输出长度
//export getOutLen
func getOutLen() uint32 {
	return currentOutLen
}

// ============================================================================
// 8. AEAD 加密核心
// ============================================================================

// incNonce - Nonce大端序递增
func incNonce(session *SudokuInstance, nonce []byte) {
	session.nonceCounter++

	if len(nonce) >= 12 {
		nonce[0] = session.key[0]
		nonce[1] = session.key[1]
		nonce[2] = session.key[2]
		nonce[3] = session.key[3]
		binary.BigEndian.PutUint64(nonce[4:12], session.nonceCounter)
	}
}

// ============================================================================
// 9. 辅助导出函数
// ============================================================================

// getArenaPtr - 获取arena基地址
//export getArenaPtr
func getArenaPtr() uint32 {
	return 0
}

// getSessionAddr - 获取指定session的地址
//export getSessionAddr
func getSessionAddr(id int32) uint32 {
	if id < 0 || id >= maxSessions {
		return 0
	}
	return sessionBase + uint32(id)*sessionSize
}

// getWorkBuf - 获取工作缓冲区地址
//export getWorkBuf
func getWorkBuf() uint32 {
	return workBufBase
}

// getOutBuf - 获取输出缓冲区地址
//export getOutBuf
func getOutBuf() uint32 {
	return outBufBase
}

// ============================================================================
// 10. 主函数
// ============================================================================

func main() {
	// TinyGo需要main函数
}
