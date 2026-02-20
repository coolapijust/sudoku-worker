/**
 * Sudoku Protocol - Cloudflare Worker Bridge
 * TinyGo Wasm 纯计算核心 + TypeScript 事件流桥接
 * 
 * 路径伪装:
 * - /v2/stream (WebSocket): Sudoku 协议代理
 * - 其他所有路径: 返回研究站 HTML
 * 
 * 加密支持:
 * - ChaCha20-Poly1305: Wasm 内实现 (官方移植)
 * - AES-128-GCM: Worker Web Crypto API
 */

// 研究站 HTML (反引号已替换为单引号)
const SUDOKU_SITE_HTML = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sudoku Matrix Encoding & ASCII Research Lab</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['Inter', 'sans-serif'],
                        mono: ['JetBrains Mono', 'monospace'],
                    },
                    colors: {
                        dark: {
                            900: '#0a0a0a',
                            800: '#111111',
                            700: '#1a1a1a',
                            600: '#222222',
                            500: '#2a2a2a',
                        },
                        accent: {
                            cyan: '#00d4ff',
                            purple: '#a855f7',
                            green: '#22c55e',
                        }
                    }
                }
            }
        }
    </script>
    <style>
        * { box-sizing: border-box; }
        body { background: #0a0a0a; color: #e5e5e5; }
        .gradient-text {
            background: linear-gradient(135deg, #00d4ff 0%, #a855f7 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        .glow-cyan { box-shadow: 0 0 20px rgba(0, 212, 255, 0.3); }
        .glow-purple { box-shadow: 0 0 20px rgba(168, 85, 247, 0.3); }
        .terminal-glow { box-shadow: 0 0 30px rgba(0, 212, 255, 0.15), inset 0 0 30px rgba(0, 212, 255, 0.05); }
        .sudoku-cell { transition: all 0.2s ease; }
        .sudoku-cell:hover { background: rgba(0, 212, 255, 0.1); }
        .sudoku-cell.selected { background: rgba(0, 212, 255, 0.2); box-shadow: inset 0 0 10px rgba(0, 212, 255, 0.3); }
        .sudoku-cell.fixed { color: #00d4ff; font-weight: 600; }
        .sudoku-cell.user-input { color: #a855f7; }
        .sudoku-cell.solved { animation: solvePulse 0.5s ease; }
        @keyframes solvePulse {
            0% { transform: scale(1); background: rgba(34, 197, 94, 0); }
            50% { transform: scale(1.1); background: rgba(34, 197, 94, 0.3); }
            100% { transform: scale(1); background: rgba(34, 197, 94, 0); }
        }
        .scan-line {
            position: absolute; top: 0; left: 0; right: 0; height: 2px;
            background: linear-gradient(90deg, transparent, #00d4ff, transparent);
            animation: scan 3s linear infinite; opacity: 0.5;
        }
        @keyframes scan { 0% { transform: translateY(0); } 100% { transform: translateY(400px); } }
        .log-entry { animation: logFadeIn 0.3s ease; }
        @keyframes logFadeIn { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: translateX(0); } }
        .terminal-scroll::-webkit-scrollbar { width: 6px; }
        .terminal-scroll::-webkit-scrollbar-track { background: #0a0a0a; }
        .terminal-scroll::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 3px; }
        .terminal-scroll::-webkit-scrollbar-thumb:hover { background: #3a3a3a; }
        .ascii-char { animation: asciiFlicker 0.1s ease; }
        @keyframes asciiFlicker { 0% { opacity: 0; } 50% { opacity: 1; color: #00d4ff; } 100% { opacity: 0.7; } }
        .btn-primary {
            background: linear-gradient(135deg, #00d4ff 0%, #0891b2 100%);
            transition: all 0.3s ease;
        }
        .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(0, 212, 255, 0.3); }
        .btn-secondary { border: 1px solid #333; transition: all 0.3s ease; }
        .btn-secondary:hover { border-color: #00d4ff; color: #00d4ff; }
        .code-block { background: #0a0a0a; border: 1px solid #222; }
        .method-get { color: #22c55e; }
        .method-post { color: #a855f7; }
        .method-ws { color: #00d4ff; }
    </style>
</head>
<body class="min-h-screen bg-dark-900 font-sans">
    <!-- Navigation -->
    <nav class="fixed top-0 left-0 right-0 z-50 bg-dark-900/80 backdrop-blur-md border-b border-dark-600">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex items-center justify-between h-16">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-cyan to-accent-purple flex items-center justify-center">
                        <i data-lucide="grid-3x3" class="w-5 h-5 text-white"></i>
                    </div>
                    <span class="font-mono font-semibold text-lg tracking-tight">SME<span class="text-accent-cyan">.</span>Lab</span>
                </div>
                <div class="hidden md:flex items-center gap-8">
                    <a href="#research" class="text-sm text-gray-400 hover:text-white transition-colors">Research</a>
                    <a href="#demo" class="text-sm text-gray-400 hover:text-white transition-colors">Demo</a>
                    <a href="#terminal" class="text-sm text-gray-400 hover:text-white transition-colors">Terminal</a>
                    <a href="#api" class="text-sm text-gray-400 hover:text-white transition-colors">API</a>
                </div>
                <div class="flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full bg-accent-green animate-pulse"></span>
                    <span class="text-xs text-gray-500 font-mono">SYSTEM ONLINE</span>
                </div>
            </div>
        </div>
    </nav>

    <!-- Hero Section -->
    <section class="pt-32 pb-20 px-4 sm:px-6 lg:px-8">
        <div class="max-w-5xl mx-auto text-center">
            <div class="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-dark-700 border border-dark-500 mb-8">
                <span class="w-2 h-2 rounded-full bg-accent-purple animate-pulse"></span>
                <span class="text-xs font-mono text-gray-400">v2.4.1 • Distributed Computing Protocol</span>
            </div>
            <h1 class="text-4xl sm:text-5xl lg:text-6xl font-bold mb-6 leading-tight">
                Sudoku Matrix Encoding<br>
                <span class="gradient-text">& ASCII Research Lab</span>
            </h1>
            <p class="text-lg sm:text-xl text-gray-400 max-w-3xl mx-auto mb-10 leading-relaxed">
                Pioneering research in matrix-based data obfuscation through constraint satisfaction problems. 
                Our distributed Sudoku solving network enables real-time ASCII stream encoding for secure 
                multi-dimensional data transmission.
            </p>
            <div class="flex flex-wrap justify-center gap-4">
                <a href="#demo" class="btn-primary px-6 py-3 rounded-lg font-medium text-black flex items-center gap-2">
                    <i data-lucide="play" class="w-4 h-4"></i>Try Interactive Demo
                </a>
                <a href="#api" class="btn-secondary px-6 py-3 rounded-lg font-medium text-gray-300 flex items-center gap-2">
                    <i data-lucide="code" class="w-4 h-4"></i>View Documentation
                </a>
            </div>
        </div>
    </section>

    <!-- Research Overview -->
    <section id="research" class="py-20 px-4 sm:px-6 lg:px-8 border-t border-dark-600">
        <div class="max-w-6xl mx-auto">
            <div class="grid lg:grid-cols-2 gap-12 items-center">
                <div>
                    <h2 class="text-3xl font-bold mb-6">Matrix Obfuscation Algorithm</h2>
                    <p class="text-gray-400 mb-6 leading-relaxed">
                        Our proprietary Sudoku Matrix Encoding (SME) algorithm transforms arbitrary data into 
                        valid 9x9 Sudoku configurations. Each cell represents an encoded byte, with row, column, 
                        and box constraints ensuring data integrity during transmission.
                    </p>
                    <p class="text-gray-400 mb-6 leading-relaxed">
                        <strong class="text-accent-cyan">Current Research:</strong> We are currently testing 
                        <strong>4x4 sub-matrix shards</strong> for optimized distributed edge computing. 
                        These smaller matrix units enable faster parallel processing while maintaining 
                        the cryptographic properties of the full 9x9 system.
                    </p>
                    <div class="space-y-4">
                        <div class="flex items-start gap-4 p-4 rounded-lg bg-dark-700 border border-dark-500">
                            <div class="w-10 h-10 rounded-lg bg-accent-cyan/10 flex items-center justify-center flex-shrink-0">
                                <i data-lucide="binary" class="w-5 h-5 text-accent-cyan"></i>
                            </div>
                            <div>
                                <h3 class="font-semibold mb-1">Binary-to-Matrix Mapping</h3>
                                <p class="text-sm text-gray-500">8-bit sequences mapped to valid Sudoku cell values (1-9)</p>
                            </div>
                        </div>
                        <div class="flex items-start gap-4 p-4 rounded-lg bg-dark-700 border border-dark-500">
                            <div class="w-10 h-10 rounded-lg bg-accent-purple/10 flex items-center justify-center flex-shrink-0">
                                <i data-lucide="shuffle" class="w-5 h-5 text-accent-purple"></i>
                            </div>
                            <div>
                                <h3 class="font-semibold mb-1">4x4 Sub-Matrix Sharding</h3>
                                <p class="text-sm text-gray-500">Optimized distributed edge computing with 4x4 shards</p>
                            </div>
                        </div>
                        <div class="flex items-start gap-4 p-4 rounded-lg bg-dark-700 border border-dark-500">
                            <div class="w-10 h-10 rounded-lg bg-accent-green/10 flex items-center justify-center flex-shrink-0">
                                <i data-lucide="zap" class="w-5 h-5 text-accent-green"></i>
                            </div>
                            <div>
                                <h3 class="font-semibold mb-1">Real-time Stream Processing</h3>
                                <p class="text-sm text-gray-500">WebSocket-based distributed solving network</p>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="relative">
                    <div class="absolute inset-0 bg-gradient-to-r from-accent-cyan/20 to-accent-purple/20 rounded-2xl blur-3xl"></div>
                    <div class="relative bg-dark-700 rounded-2xl p-6 border border-dark-500">
                        <div class="flex items-center justify-between mb-4">
                            <span class="text-sm font-mono text-gray-500">Encoding Pipeline</span>
                            <div class="flex gap-2">
                                <span class="w-3 h-3 rounded-full bg-red-500"></span>
                                <span class="w-3 h-3 rounded-full bg-yellow-500"></span>
                                <span class="w-3 h-3 rounded-full bg-green-500"></span>
                            </div>
                        </div>
                        <div class="space-y-3 font-mono text-sm">
                            <div class="p-3 rounded bg-dark-800 border-l-2 border-accent-cyan">
                                <span class="text-gray-500">INPUT:</span><span class="text-accent-cyan"> "Hello, World!"</span>
                            </div>
                            <div class="flex justify-center"><i data-lucide="arrow-down" class="w-4 h-4 text-gray-600"></i></div>
                            <div class="p-3 rounded bg-dark-800 border-l-2 border-accent-purple">
                                <span class="text-gray-500">4x4 SHARD:</span><span class="text-accent-purple"> Encoded Sub-Matrix</span>
                            </div>
                            <div class="flex justify-center"><i data-lucide="arrow-down" class="w-4 h-4 text-gray-600"></i></div>
                            <div class="p-3 rounded bg-dark-800 border-l-2 border-accent-green">
                                <span class="text-gray-500">MATRIX:</span><span class="text-accent-green"> 9x9 Grid Configuration</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>

    <!-- Interactive Demo -->
    <section id="demo" class="py-20 px-4 sm:px-6 lg:px-8 border-t border-dark-600">
        <div class="max-w-6xl mx-auto">
            <div class="text-center mb-12">
                <h2 class="text-3xl font-bold mb-4">Interactive Sudoku Solver</h2>
                <p class="text-gray-400 max-w-2xl mx-auto">
                    Experience our constraint satisfaction engine. The solver uses 4x4 sub-matrix 
                    optimizations for distributed processing.
                </p>
            </div>
            <div class="grid lg:grid-cols-2 gap-8">
                <div class="bg-dark-700 rounded-2xl p-6 border border-dark-500">
                    <div class="flex items-center justify-between mb-6">
                        <span class="text-sm font-mono text-gray-500">9x9 Matrix (4x4 shard mode)</span>
                        <div class="flex gap-2">
                            <button onclick="generatePuzzle()" class="px-3 py-1.5 text-xs rounded bg-dark-600 hover:bg-dark-500 transition-colors font-mono">Generate</button>
                            <button onclick="clearGrid()" class="px-3 py-1.5 text-xs rounded bg-dark-600 hover:bg-dark-500 transition-colors font-mono">Clear</button>
                        </div>
                    </div>
                    <div id="sudoku-grid" class="grid grid-cols-9 gap-0.5 bg-dark-600 p-0.5 rounded-lg max-w-md mx-auto"></div>
                    <div class="flex gap-3 mt-6 justify-center">
                        <button onclick="solveSudoku()" id="solve-btn" class="btn-primary px-6 py-3 rounded-lg font-medium text-black flex items-center gap-2">
                            <i data-lucide="cpu" class="w-4 h-4"></i>Solve Matrix
                        </button>
                        <button onclick="validateGrid()" class="btn-secondary px-6 py-3 rounded-lg font-medium text-gray-300 flex items-center gap-2">
                            <i data-lucide="check-circle" class="w-4 h-4"></i>Validate
                        </button>
                    </div>
                </div>
                <div class="bg-dark-700 rounded-2xl p-6 border border-dark-500">
                    <div class="flex items-center justify-between mb-6">
                        <span class="text-sm font-mono text-gray-500">Computation Log</span>
                        <div class="flex items-center gap-2">
                            <span class="w-2 h-2 rounded-full bg-accent-green animate-pulse"></span>
                            <span class="text-xs text-gray-500 font-mono">LIVE</span>
                        </div>
                    </div>
                    <div id="computation-log" class="h-80 overflow-y-auto terminal-scroll font-mono text-xs space-y-1 bg-dark-800 rounded-lg p-4">
                        <div class="text-gray-500">// System initialized...</div>
                        <div class="text-gray-500">// 4x4 sub-matrix optimization enabled...</div>
                    </div>
                    <div class="mt-4 flex items-center gap-4 text-xs font-mono">
                        <div class="flex items-center gap-2"><span class="text-gray-500">Iterations:</span><span id="iteration-count" class="text-accent-cyan">0</span></div>
                        <div class="flex items-center gap-2"><span class="text-gray-500">4x4 Shards:</span><span id="shard-count" class="text-accent-purple">0</span></div>
                    </div>
                </div>
            </div>
        </div>
    </section>

    <!-- ASCII Terminal -->
    <section id="terminal" class="py-20 px-4 sm:px-6 lg:px-8 border-t border-dark-600">
        <div class="max-w-6xl mx-auto">
            <div class="text-center mb-12">
                <h2 class="text-3xl font-bold mb-4">ASCII Stream Terminal</h2>
                <p class="text-gray-400 max-w-2xl mx-auto">Real-time data stream from our distributed solving network via WebSocket.</p>
            </div>
            <div class="relative">
                <div class="absolute inset-0 bg-accent-cyan/5 rounded-2xl blur-xl"></div>
                <div class="relative bg-black rounded-2xl border border-dark-500 terminal-glow overflow-hidden">
                    <div class="flex items-center justify-between px-4 py-3 bg-dark-800 border-b border-dark-600">
                        <div class="flex items-center gap-3">
                            <div class="flex gap-1.5">
                                <span class="w-3 h-3 rounded-full bg-red-500"></span>
                                <span class="w-3 h-3 rounded-full bg-yellow-500"></span>
                                <span class="w-3 h-3 rounded-full bg-green-500"></span>
                            </div>
                            <span class="text-sm font-mono text-gray-400 ml-3">sme-terminal — wss://host/v2/stream</span>
                        </div>
                        <div class="flex items-center gap-3">
                            <button onclick="toggleTerminal()" id="terminal-toggle" class="text-xs font-mono px-3 py-1 rounded bg-accent-green/20 text-accent-green">PAUSE</button>
                            <i data-lucide="wifi" class="w-4 h-4 text-accent-green"></i>
                        </div>
                    </div>
                    <div class="relative">
                        <div class="scan-line"></div>
                        <div id="terminal-output" class="h-96 overflow-y-auto terminal-scroll p-4 font-mono text-sm"></div>
                    </div>
                </div>
            </div>
        </div>
    </section>

    <!-- API Documentation -->
    <section id="api" class="py-20 px-4 sm:px-6 lg:px-8 border-t border-dark-600">
        <div class="max-w-6xl mx-auto">
            <div class="text-center mb-12">
                <h2 class="text-3xl font-bold mb-4">API Documentation</h2>
                <p class="text-gray-400 max-w-2xl mx-auto">Access our distributed Sudoku solving network.</p>
            </div>
            <div class="bg-dark-700 rounded-xl p-6 border border-dark-500 max-w-3xl mx-auto">
                <div class="flex items-center gap-3 mb-4">
                    <span class="method-ws font-mono font-bold">WS</span>
                    <code class="text-lg">wss://host/v2/stream</code>
                </div>
                <p class="text-gray-400 mb-4">WebSocket connection for real-time 4x4 matrix shard stream.</p>
                <div class="code-block rounded-lg p-4 font-mono text-sm overflow-x-auto">
                    <div class="text-gray-500">// JavaScript WebSocket client</div>
                    <div class="text-accent-purple">const</div> <div class="text-white inline"> ws = </div><div class="text-accent-purple inline">new</div> <div class="text-accent-cyan inline"> WebSocket</div><div class="text-white">(</div><div class="text-accent-green">'wss://host/v2/stream'</div><div class="text-white">);</div>
                </div>
            </div>
        </div>
    </section>

    <!-- Footer -->
    <footer class="py-12 px-4 sm:px-6 lg:px-8 border-t border-dark-600">
        <div class="max-w-6xl mx-auto text-center text-sm text-gray-600 font-mono">
            &copy; 2024 SME Lab. 4x4 Sub-Matrix Research Division.
        </div>
    </footer>

    <script>
        lucide.createIcons();
        let selectedCell = null, grid = Array(9).fill(null).map(() => Array(9).fill(0));
        let fixedCells = Array(9).fill(null).map(() => Array(9).fill(false)), isSolving = false;
        let terminalRunning = true, totalChars = 0;
        const asciiChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?/';

        function initGrid() {
            const gridEl = document.getElementById('sudoku-grid');
            gridEl.innerHTML = '';
            for (let row = 0; row < 9; row++) {
                for (let col = 0; col < 9; col++) {
                    const cell = document.createElement('div');
                    cell.className = 'sudoku-cell w-full aspect-square flex items-center justify-center text-lg font-mono cursor-pointer bg-dark-800';
                    cell.dataset.row = row; cell.dataset.col = col;
                    if (row % 3 === 0) cell.style.borderTop = '2px solid #555';
                    if (col % 3 === 0) cell.style.borderLeft = '2px solid #555';
                    if (row === 8) cell.style.borderBottom = '2px solid #555';
                    if (col === 8) cell.style.borderRight = '2px solid #555';
                    cell.addEventListener('click', () => selectCell(row, col));
                    gridEl.appendChild(cell);
                }
            }
            generatePuzzle();
        }

        function selectCell(row, col) {
            if (isSolving) return;
            document.querySelectorAll('.sudoku-cell').forEach(c => c.classList.remove('selected'));
            selectedCell = { row, col };
            document.querySelector('[data-row="' + row + '"][data-col="' + col + '"]').classList.add('selected');
        }

        function setCellValue(row, col, value) {
            grid[row][col] = value;
            const cellEl = document.querySelector('[data-row="' + row + '"][data-col="' + col + '"]');
            cellEl.textContent = value || '';
            if (value > 0) {
                if (fixedCells[row][col]) cellEl.classList.add('fixed');
                else cellEl.classList.add('user-input');
            }
        }

        function generatePuzzle() {
            grid = Array(9).fill(null).map(() => Array(9).fill(0));
            fixedCells = Array(9).fill(null).map(() => Array(9).fill(false));
            document.querySelectorAll('.sudoku-cell').forEach(c => { c.textContent = ''; c.classList.remove('fixed', 'user-input', 'solved'); });
            solveGrid(grid);
            const cellsToRemove = 40 + Math.floor(Math.random() * 15);
            let removed = 0;
            while (removed < cellsToRemove) {
                const row = Math.floor(Math.random() * 9), col = Math.floor(Math.random() * 9);
                if (grid[row][col] !== 0) { grid[row][col] = 0; removed++; }
            }
            for (let row = 0; row < 9; row++) {
                for (let col = 0; col < 9; col++) {
                    if (grid[row][col] !== 0) { fixedCells[row][col] = true; setCellValue(row, col, grid[row][col]); }
                }
            }
            log('Generated new puzzle with 4x4 shard optimization', 'info');
        }

        function clearGrid() {
            if (isSolving) return;
            for (let row = 0; row < 9; row++) {
                for (let col = 0; col < 9; col++) {
                    if (!fixedCells[row][col]) {
                        grid[row][col] = 0;
                        const cellEl = document.querySelector('[data-row="' + row + '"][data-col="' + col + '"]]');
                        cellEl.textContent = '';
                        cellEl.classList.remove('user-input', 'solved');
                    }
                }
            }
            log('Cleared user inputs', 'info');
        }

        function isValid(grid, row, col, num) {
            for (let x = 0; x < 9; x++) if (grid[row][x] === num) return false;
            for (let x = 0; x < 9; x++) if (grid[x][col] === num) return false;
            const startRow = row - row % 3, startCol = col - col % 3;
            for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (grid[i + startRow][j + startCol] === num) return false;
            return true;
        }

        function solveGrid(grid) {
            for (let row = 0; row < 9; row++) {
                for (let col = 0; col < 9; col++) {
                    if (grid[row][col] === 0) {
                        for (let num = 1; num <= 9; num++) {
                            if (isValid(grid, row, col, num)) {
                                grid[row][col] = num;
                                if (solveGrid(grid)) return true;
                                grid[row][col] = 0;
                            }
                        }
                        return false;
                    }
                }
            }
            return true;
        }

        async function solveSudoku() {
            if (isSolving) return;
            isSolving = true;
            document.getElementById('solve-btn').disabled = true;
            document.getElementById('solve-btn').innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Solving...';
            lucide.createIcons();
            log('Initializing 4x4 shard-based solver...', 'info');
            const solution = grid.map(row => [...row]);
            solveGrid(solution);
            for (let row = 0; row < 9; row++) {
                for (let col = 0; col < 9; col++) {
                    if (!fixedCells[row][col] && solution[row][col] !== 0) {
                        await new Promise(r => setTimeout(r, 10));
                        setCellValue(row, col, solution[row][col]);
                        document.querySelector('[data-row="' + row + '"][data-col="' + col + '"]').classList.add('solved');
                    }
                }
            }
            log('Solution complete using 4x4 sub-matrix optimization', 'success');
            document.getElementById('solve-btn').disabled = false;
            document.getElementById('solve-btn').innerHTML = '<i data-lucide="cpu" class="w-4 h-4"></i> Solve Matrix';
            lucide.createIcons();
            isSolving = false;
        }

        function validateGrid() { log('Grid validation: PASSED (4x4 shard compatible)', 'success'); }

        function log(message, type = 'info') {
            const logEl = document.getElementById('computation-log');
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
            let colorClass = 'text-gray-400';
            if (type === 'success') colorClass = 'text-accent-green';
            if (type === 'error') colorClass = 'text-red-500';
            entry.innerHTML = '<span class="text-gray-600">[' + timestamp + ']</span> <span class="' + colorClass + '">' + message + '</span>';
            logEl.appendChild(entry);
            logEl.scrollTop = logEl.scrollHeight;
        }

        function generateASCIIStream() {
            const terminal = document.getElementById('terminal-output');
            const line = document.createElement('div');
            line.className = 'mb-1';
            let lineContent = '';
            const lineLength = 64 + Math.floor(Math.random() * 32);
            const now = new Date();
            const timestamp = '[' + now.toISOString().split('T')[1].split('.')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0') + ']';
            lineContent += '<span class="text-gray-600">' + timestamp + '</span> <span class="text-accent-cyan">0x' + Math.random().toString(16).substr(2, 8) + '</span> ';
            for (let i = 0; i < lineLength; i++) {
                const char = asciiChars[Math.floor(Math.random() * asciiChars.length)];
                lineContent += '<span class="ascii-char" style="animation-delay: ' + (i * 0.01) + 's">' + char + '</span>';
                totalChars++;
            }
            line.innerHTML = lineContent;
            terminal.appendChild(line);
            while (terminal.children.length > 100) terminal.removeChild(terminal.firstChild);
            terminal.scrollTop = terminal.scrollHeight;
            document.getElementById('total-chars').textContent = totalChars.toLocaleString();
        }

        function toggleTerminal() {
            terminalRunning = !terminalRunning;
            const btn = document.getElementById('terminal-toggle');
            btn.textContent = terminalRunning ? 'PAUSE' : 'RESUME';
            btn.className = terminalRunning ? 'text-xs font-mono px-3 py-1 rounded bg-accent-green/20 text-accent-green' : 'text-xs font-mono px-3 py-1 rounded bg-yellow-500/20 text-yellow-500';
        }

        setInterval(() => { if (terminalRunning) generateASCIIStream(); }, 100);

        document.addEventListener('DOMContentLoaded', () => {
            initGrid();
            const terminal = document.getElementById('terminal-output');
            terminal.innerHTML = '<div class="text-gray-500">// SME Terminal v2.4.1</div><div class="text-gray-500">// 4x4 sub-matrix optimization enabled</div><div class="text-accent-green">// Connected to wss://host/v2/stream</div>';
        });
    </script>
</body>
</html>`;

// Wasm 模块类型定义
interface SudokuWasmExports {
  memory: WebAssembly.Memory;
  arenaMalloc: (size: number) => number;
  arenaFree: (ptr: number) => void;
  initSession: (keyPtr: number, keyLen: number, cipherType: number, layoutType: number) => number;
  closeSession: (id: number) => void;
  mask: (id: number, inPtr: number, inLen: number) => number;
  unmask: (id: number, inPtr: number, inLen: number) => number;
  getOutLen: () => number;
  aeadEncrypt: (id: number, plaintextPtr: number, plaintextLen: number, outPtr: number) => number;
  aeadDecrypt: (id: number, ciphertextPtr: number, ciphertextLen: number, outPtr: number) => number;
  initCodecTablesWithKey: (keyPtr: number, keyLen: number) => void;
}

const CipherType = { None: 0, AES128GCM: 1, ChaCha20Poly: 2 };
const LayoutType = { ASCII: 0, Entropy: 1 };

class WasmInstance {
  private exports: SudokuWasmExports;
  private initialized: boolean = false;
  
  constructor(wasmModule: WebAssembly.Module) {
    const instance = new WebAssembly.Instance(wasmModule, { env: { abort: () => { throw new Error('Wasm abort'); } } });
    this.exports = instance.exports as unknown as SudokuWasmExports;
  }
  
  getMemory(): Uint8Array { return new Uint8Array(this.exports.memory.buffer); }
  
  writeToMemory(data: Uint8Array): [number, boolean] {
    const ptr = this.exports.arenaMalloc(data.length);
    if (ptr === 0) throw new Error('Wasm arenaMalloc failed');
    this.getMemory().set(data, ptr);
    return [ptr, true];
  }
  
  readFromMemory(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer, ptr, len).slice();
  }
  
  initCodecTables(key: Uint8Array): void {
    if (this.initialized) return;
    const [keyPtr, needFree] = this.writeToMemory(key.slice(0, 32));
    try {
      this.exports.initCodecTablesWithKey(keyPtr, key.length);
      this.initialized = true;
    } finally { if (needFree) this.exports.arenaFree(keyPtr); }
  }

  initSession(cipherType: number): number {
    const dummyKey = new Uint8Array(32);
    const [keyPtr, needFree] = this.writeToMemory(dummyKey);
    try {
      const sessionId = this.exports.initSession(keyPtr, dummyKey.length, cipherType, LayoutType.ASCII);
      if (sessionId < 0) throw new Error(`Failed to init session: ${sessionId}`);
      return sessionId;
    } finally { if (needFree) this.exports.arenaFree(keyPtr); }
  }

  closeSession(sessionId: number): void { this.exports.closeSession(sessionId); }

  mask(sessionId: number, data: Uint8Array): Uint8Array {
    const [inPtr, needFree] = this.writeToMemory(data);
    try {
      const outPtr = this.exports.mask(sessionId, inPtr, data.length);
      const outLen = this.exports.getOutLen();
      if (outPtr === 0 || outLen === 0) return new Uint8Array(0);
      return this.readFromMemory(outPtr, outLen);
    } finally { if (needFree) this.exports.arenaFree(inPtr); }
  }

  unmask(sessionId: number, data: Uint8Array): Uint8Array {
    const [inPtr, needFree] = this.writeToMemory(data);
    try {
      const outPtr = this.exports.unmask(sessionId, inPtr, data.length);
      const outLen = this.exports.getOutLen();
      if (outPtr === 0 || outLen === 0) return new Uint8Array(0);
      return this.readFromMemory(outPtr, outLen);
    } finally { if (needFree) this.exports.arenaFree(inPtr); }
  }

  aeadEncrypt(sessionId: number, plaintext: Uint8Array): Uint8Array {
    const [inPtr] = this.writeToMemory(plaintext);
    const outPtr = this.exports.arenaMalloc(plaintext.length + 16);
    if (outPtr === 0) { this.exports.arenaFree(inPtr); throw new Error('Failed to allocate output buffer'); }
    try {
      const resultLen = this.exports.aeadEncrypt(sessionId, inPtr, plaintext.length, outPtr);
      if (resultLen === 0) throw new Error('AEAD encryption failed');
      return this.readFromMemory(outPtr, resultLen);
    } finally { this.exports.arenaFree(inPtr); this.exports.arenaFree(outPtr); }
  }

  aeadDecrypt(sessionId: number, ciphertext: Uint8Array): Uint8Array {
    const [inPtr] = this.writeToMemory(ciphertext);
    const outPtr = this.exports.arenaMalloc(ciphertext.length);
    if (outPtr === 0) { this.exports.arenaFree(inPtr); throw new Error('Failed to allocate output buffer'); }
    try {
      const resultLen = this.exports.aeadDecrypt(sessionId, inPtr, ciphertext.length, outPtr);
      if (resultLen === 0) throw new Error('AEAD decryption failed');
      return this.readFromMemory(outPtr, resultLen);
    } finally { this.exports.arenaFree(inPtr); this.exports.arenaFree(outPtr); }
  }
}

class AeadManager {
  private key: Uint8Array;
  private cryptoKey: CryptoKey | null = null;
  private cipherType: number;
  private wasm: WasmInstance;
  private sessionId: number;
  
  constructor(method: string, key: Uint8Array, wasm: WasmInstance, sessionId: number) {
    this.key = key.slice(0, 32);
    this.cipherType = this.parseCipherMethod(method);
    this.wasm = wasm;
    this.sessionId = sessionId;
  }
  
  private parseCipherMethod(method: string): number {
    if (method.toLowerCase().includes('aes')) return CipherType.AES128GCM;
    if (method.toLowerCase().includes('chacha20')) return CipherType.ChaCha20Poly;
    return CipherType.None;
  }
  
  async init(): Promise<void> {
    if (this.cipherType === CipherType.AES128GCM) {
      this.cryptoKey = await crypto.subtle.importKey('raw', this.key.slice(0, 16), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    }
  }
  
  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    let ciphertext: Uint8Array;
    
    switch (this.cipherType) {
      case CipherType.None:
        ciphertext = plaintext;
        break;
      case CipherType.ChaCha20Poly:
        ciphertext = this.wasm.aeadEncrypt(this.sessionId, plaintext);
        break;
      case CipherType.AES128GCM:
        if (!this.cryptoKey) throw new Error('CryptoKey not initialized');
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, this.cryptoKey, plaintext);
        ciphertext = new Uint8Array(12 + encrypted.byteLength);
        ciphertext.set(nonce);
        ciphertext.set(new Uint8Array(encrypted), 12);
        break;
      default:
        throw new Error(`Unsupported cipher: ${this.cipherType}`);
    }
    
    // 添加 2 字节帧长度头 (大端序)，与原版 Go 协议一致
    const frameLen = ciphertext.length;
    const frame = new Uint8Array(2 + frameLen);
    frame[0] = (frameLen >> 8) & 0xFF;  // 大端序高字节
    frame[1] = frameLen & 0xFF;           // 大端序低字节
    frame.set(ciphertext, 2);
    
    return frame;
  }
  
  async decrypt(data: Uint8Array): Promise<Uint8Array> {
    // 读取 2 字节帧长度头 (大端序)
    if (data.length < 2) {
      throw new Error('Frame too short: missing length header');
    }
    const frameLen = (data[0] << 8) | data[1];
    
    if (data.length < 2 + frameLen) {
      throw new Error(`Incomplete frame: expected ${frameLen} bytes, got ${data.length - 2}`);
    }
    
    const ciphertext = data.subarray(2, 2 + frameLen);
    
    let plaintext: Uint8Array;
    
    switch (this.cipherType) {
      case CipherType.None:
        plaintext = ciphertext;
        break;
      case CipherType.ChaCha20Poly:
        plaintext = this.wasm.aeadDecrypt(this.sessionId, ciphertext);
        break;
      case CipherType.AES128GCM:
        if (!this.cryptoKey) throw new Error('CryptoKey not initialized');
        if (ciphertext.length < 12) throw new Error('Ciphertext too short: missing nonce');
        const nonce = ciphertext.slice(0, 12);
        const encrypted = ciphertext.slice(12);
        plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, this.cryptoKey, encrypted));
        break;
      default:
        throw new Error(`Unsupported cipher: ${this.cipherType}`);
    }
    
    return plaintext;
  }
}

/**
 * Worker 配置接口
 * 
 * 密钥管理:
 * - Secrets (敏感，加密存储): SUDOKU_KEY, ED25519_PRIVATE_KEY
 *   使用: wrangler secret put KEY_NAME
 * 
 * - Vars (公开，明文存储): ED25519_PUBLIC_KEY, UPSTREAM_HOST 等
 *   在 wrangler.toml [vars] 段配置
 */
interface Env {
  // 上游服务器配置
  UPSTREAM_HOST: string;
  UPSTREAM_PORT: string;
  
  // AEAD 对称加密密钥 (Secret)
  // 格式: 32字节 hex (64字符)，用于 ChaCha20-Poly1305 或 AES-GCM
  SUDOKU_KEY: string;
  
  // 加密方法: "none" | "aes-128-gcm" | "chacha20-poly1305"
  CIPHER_METHOD: string;
  
  // Sudoku 布局模式: "ascii" | "entropy"
  LAYOUT_MODE: string;
  
  // Ed25519 公钥 (可选，Vars，可公开)
  // 格式: 32字节 hex (64字符)，用于 Worker 身份验证
  ED25519_PUBLIC_KEY?: string;
  
  // Ed25519 私钥 (可选，Secret)
  // 格式: 32字节 hex (64字符)，用于签名证明身份
  ED25519_PRIVATE_KEY?: string;
  
  // 密钥派生盐值 (可选)
  // 用于从密码派生密钥 (PBKDF2)
  KEY_DERIVE_SALT?: string;
  
  // Wasm 模块
  SUDOKU_WASM: WebAssembly.Module;
}

/**
 * 从字符串派生密钥 (SHA-256)
 * 如果输入是 hex 字符串 (64字符)，先解码再 hash
 */
async function deriveKey(keyStr: string): Promise<Uint8Array> {
  // 检查是否是 hex 编码 (64字符 = 32字节)
  if (/^[0-9a-fA-F]{64}$/.test(keyStr)) {
    return hexToBytes(keyStr);
  }
  // 否则使用 SHA-256 派生
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyStr)));
}

/**
 * Hex 字符串转 Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Uint8Array 转 Hex 字符串
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 密钥配置验证
 */
function validateKeyConfig(env: Env): void {
  // 验证 SUDOKU_KEY 格式
  if (!env.SUDOKU_KEY) {
    throw new Error('SUDOKU_KEY is required (set via: wrangler secret put SUDOKU_KEY)');
  }
  
  // 如果是 hex 格式，验证长度
  if (/^[0-9a-fA-F]+$/.test(env.SUDOKU_KEY)) {
    const expectedLen = env.CIPHER_METHOD === 'aes-128-gcm' ? 32 : 64; // AES-128: 16字节=32hex, ChaCha20: 32字节=64hex
    if (env.SUDOKU_KEY.length !== expectedLen) {
      console.warn(`Warning: SUDOKU_KEY hex length is ${env.SUDOKU_KEY.length}, expected ${expectedLen} for ${env.CIPHER_METHOD}`);
    }
  }
  
  // 验证 Ed25519 公钥 (如果配置了)
  if (env.ED25519_PUBLIC_KEY) {
    if (!/^[0-9a-fA-F]{64}$/.test(env.ED25519_PUBLIC_KEY)) {
      throw new Error('ED25519_PUBLIC_KEY must be 64 hex characters (32 bytes)');
    }
  }
  
  // 验证 Ed25519 私钥 (如果配置了)
  if (env.ED25519_PRIVATE_KEY) {
    if (!/^[0-9a-fA-F]{64}$/.test(env.ED25519_PRIVATE_KEY)) {
      throw new Error('ED25519_PRIVATE_KEY must be 64 hex characters (32 bytes)');
    }
  }
}

async function connectUpstream(env: Env): Promise<Socket> {
  return connect(`${env.UPSTREAM_HOST}:${env.UPSTREAM_PORT}`, { secureTransport: 'off' });
}

async function handleWebSocket(ws: WebSocket, env: Env, subprotocol: string = 'sudoku-tcp-v1'): Promise<void> {
  // 验证密钥配置
  validateKeyConfig(env);
  
  const wasm = new WasmInstance(env.SUDOKU_WASM);
  const cipherMethod = env.CIPHER_METHOD || 'none';
  let cipherType = CipherType.None;
  if (cipherMethod.toLowerCase().includes('chacha20')) cipherType = CipherType.ChaCha20Poly;
  else if (cipherMethod.toLowerCase().includes('aes')) cipherType = CipherType.AES128GCM;
  
  // 从 key 派生密钥数据
  const keyData = await deriveKey(env.SUDOKU_KEY || 'default-key');
  
  // 使用 key 初始化编解码表 (确保与原版 Go 一致的网格打乱顺序)
  wasm.initCodecTables(keyData);
  
  // 使用 key 初始化 session
  const [keyPtr, needFree] = wasm.writeToMemory(keyData);
  try {
    var sessionId = wasm.exports.initSession(keyPtr, keyData.length, cipherType, LayoutType.ASCII);
  } finally { if (needFree) wasm.exports.free(keyPtr); }
  
  const aead = new AeadManager(cipherMethod, keyData, wasm, sessionId);
  await aead.init();
  
  let upstreamSocket: Socket;
  try {
    upstreamSocket = await connectUpstream(env);
  } catch (err) {
    console.error('Failed to connect upstream:', err);
    ws.close(1011, 'Upstream connection failed');
    wasm.closeSession(sessionId);
    return;
  }
  
  ws.accept();
  const upstreamWriter = upstreamSocket.writable.getWriter();
  const upstreamReader = upstreamSocket.readable.getReader();
  
  const cleanup = () => {
    try { upstreamWriter.releaseLock(); upstreamSocket.close(); } catch {}
    try { wasm.closeSession(sessionId); } catch {}
  };
  
  ws.addEventListener('message', async (event) => {
    try {
      let data: Uint8Array = typeof event.data === 'string' ? new TextEncoder().encode(event.data) : new Uint8Array(event.data);
      const unmasked = wasm.unmask(sessionId, data);
      const plaintext = await aead.decrypt(unmasked);
      await upstreamWriter.write(plaintext);
    } catch (err) {
      console.error('Error processing WebSocket message:', err);
      ws.close(1011, 'Processing error');
      cleanup();
    }
  });
  
  ws.addEventListener('close', cleanup);
  ws.addEventListener('error', cleanup);
  
  (async () => {
    try {
      while (true) {
        const { done, value } = await upstreamReader.read();
        if (done) { ws.close(1000, 'Upstream closed'); break; }
        const ciphertext = await aead.encrypt(value);
        const masked = wasm.mask(sessionId, ciphertext);
        ws.send(masked);
      }
    } catch (err) {
      console.error('Error reading from upstream:', err);
      ws.close(1011, 'Upstream read error');
    } finally { cleanup(); }
  })();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get('Upgrade');
    const subprotocolHeader = request.headers.get('Sec-WebSocket-Protocol');
    
    const expectedSubprotocol = 'sudoku-tcp-v1';
    
    // 只有 /v2/stream 路径且是 WebSocket 升级才触发 Sudoku 协议
    if (url.pathname === '/v2/stream' && upgradeHeader === 'websocket') {
      // 验证子协议协商 (原版 Go 客户端要求 sudoku-tcp-v1)
      if (subprotocolHeader !== expectedSubprotocol) {
        console.warn(`WebSocket subprotocol mismatch: expected '${expectedSubprotocol}', got '${subprotocolHeader || 'none'}'`);
      }
      
      const [client, server] = Object.values(new WebSocketPair());
      ctx.waitUntil(handleWebSocket(server, env, expectedSubprotocol));
      return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': expectedSubprotocol } });
    }
    
    // 其他所有路径返回研究站 HTML
    return new Response(SUDOKU_SITE_HTML, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' },
    });
  },
};

declare global {
  interface WebSocketPair { 0: WebSocket; 1: WebSocket; }
  var WebSocketPair: { new (): WebSocketPair; };
  interface Socket { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close(): void; }
  interface SocketOptions { secureTransport: 'on' | 'off' | 'starttls'; }
  function connect(address: string, options?: SocketOptions): Socket;
  interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; }
}
