// +build ignore

// 此程序用于生成完整的 288 个 4x4 数独网格数据
// 使用方法: go run generate_grids.go

package main

import (
	"fmt"
)

// Grid 表示 4x4 数独网格
type Grid [16]uint8

// GenerateAllGrids 生成所有有效的 4x4 Sudoku 网格
func GenerateAllGrids() []Grid {
	var grids []Grid
	var g Grid
	var backtrack func(int)

	backtrack = func(idx int) {
		if idx == 16 {
			grids = append(grids, g)
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
	return grids
}

func main() {
	grids := GenerateAllGrids()
	
	fmt.Printf("// 预计算的所有有效4x4数独网格\n")
	fmt.Printf("// 共%d个，每个16字节\n", len(grids))
	fmt.Printf("var allGridsData = [%d][16]uint8{\n", len(grids))
	
	for i, grid := range grids {
		fmt.Printf("\t{%d, %d, %d, %d, %d, %d, %d, %d, %d, %d, %d, %d, %d, %d, %d, %d}, // %d\n",
			grid[0], grid[1], grid[2], grid[3],
			grid[4], grid[5], grid[6], grid[7],
			grid[8], grid[9], grid[10], grid[11],
			grid[12], grid[13], grid[14], grid[15],
			i)
	}
	
	fmt.Println("}")
	
	fmt.Printf("\n// 验证: 共 %d 个网格\n", len(grids))
}
