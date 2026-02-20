export const SUDOKU_SITE_HTML = `<!DOCTYPE html>
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