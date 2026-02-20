# Sudoku Protocol Wasm 编译脚本
# 使用 TinyGo 编译为 Wasm 模块

.PHONY: all build clean test install-tinygo

# 默认目标
all: build

# 编译 TinyGo Wasm 模块
build: sudoku.wasm

# TinyGo 编译参数
# -target wasm: 目标平台为 WebAssembly
# -no-debug: 移除调试信息，减小体积
# -gc=leaking: 使用 Leak GC (无回收，适合固定内存模型)
# -opt=z: 优化体积 (z = size)
# -scheduler=none: 禁用调度器 (无 goroutine)
TINYGO_FLAGS := -target wasm \
	-no-debug \
	-gc=leaking \
	-opt=z \
	-scheduler=none \
	-o sudoku.wasm

sudoku.wasm: main.go crypto.go
	@echo "Building TinyGo Wasm module..."
	tinygo build $(TINYGO_FLAGS) .
	@echo "Build complete: sudoku.wasm"
	@ls -lh sudoku.wasm

# 检查 TinyGo 安装
check-tinygo:
	@which tinygo > /dev/null || (echo "Error: TinyGo not found. Install from https://tinygo.org/getting-started/" && exit 1)
	@tinygo version

# 安装 TinyGo (Ubuntu/Debian)
install-tinygo-ubuntu:
	@echo "Installing TinyGo..."
	wget https://github.com/tinygo-org/tinygo/releases/download/v0.30.0/tinygo_0.30.0_amd64.deb
	sudo dpkg -i tinygo_0.30.0_amd64.deb
	rm tinygo_0.30.0_amd64.deb

# 安装 TinyGo (macOS)
install-tinygo-macos:
	@echo "Installing TinyGo..."
	brew tap tinygo-org/tools
	brew install tinygo

# 清理构建产物
clean:
	rm -f sudoku.wasm
	rm -rf dist/
	@echo "Cleaned build artifacts"

# 测试 (需要安装 vitest)
test: build
	npm test

# 开发模式
dev: build
	npm run dev

# 部署到 Cloudflare
deploy: build
	npm run deploy

# 分析 Wasm 体积
analyze: build
	@which wasm2wat > /dev/null || (echo "Installing wabt..." && npm install -g wabt)
	wasm2wat sudoku.wasm -o sudoku.wat
	@echo "Wasm text format: sudoku.wat"
	@echo "Wasm binary size:"
	@ls -lh sudoku.wasm
	@echo "Section sizes:"
	@wasm-objdump -h sudoku.wasm 2>/dev/null || echo "wasm-objdump not found, install wabt"

# 验证 Wasm 导出
verify: build
	@echo "Checking Wasm exports..."
	@which wasm2wat > /dev/null || (echo "wabt not installed, skipping verification" && exit 0)
	@wasm2wat sudoku.wasm | grep -E "(export|\\(func)" | head -30

# 生成统计信息
stats: build
	@echo "=== Wasm Module Statistics ==="
	@echo "Binary size:"
	@ls -lh sudoku.wasm | awk '{print "  " $$5 " " $$9}'
	@echo ""
	@echo "Sections:"
	@wasm-objdump -h sudoku.wasm 2>/dev/null || echo "  (wasm-objdump not available)"
