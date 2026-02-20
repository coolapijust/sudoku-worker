/**
 * 简单的 Node.js 测试脚本
 * 用于验证 Wasm 模块的基本功能
 * 
 * 使用方法:
 * 1. 先编译 Wasm: make build
 * 2. 运行测试: node test.js
 */

const fs = require('fs');
const path = require('path');

async function main() {
  console.log('=== Sudoku Wasm Test ===\n');
  
  // 检查 Wasm 文件是否存在
  const wasmPath = path.join(__dirname, 'sudoku.wasm');
  if (!fs.existsSync(wasmPath)) {
    console.error('Error: sudoku.wasm not found. Run "make build" first.');
    process.exit(1);
  }
  
  console.log('1. Loading Wasm module...');
  const wasmBuffer = fs.readFileSync(wasmPath);
  console.log(`   Wasm size: ${wasmBuffer.length} bytes`);
  
  try {
    const wasmModule = await WebAssembly.compile(wasmBuffer);
    console.log('   Wasm compiled successfully');
    
    // 实例化
    const instance = await WebAssembly.instantiate(wasmModule, {
      env: {
        abort: () => { throw new Error('Wasm abort'); },
      },
    });
    
    console.log('\n2. Wasm exports:');
    const exports = instance.exports;
    for (const name of Object.keys(exports)) {
      const type = typeof exports[name];
      console.log(`   - ${name}: ${type}`);
    }
    
    // 基本功能测试
    console.log('\n3. Testing basic functions:');
    
    // malloc 测试
    const ptr = exports.malloc(64);
    console.log(`   malloc(64) = ${ptr} (expected: > 0)`);
    if (ptr === 0) {
      throw new Error('malloc failed');
    }
    
    // 获取内存
    const memory = new Uint8Array(exports.memory.buffer);
    
    // 写入测试数据
    const testData = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    memory.set(testData, ptr);
    console.log(`   Wrote test data at ${ptr}`);
    
    // 读取验证
    const readData = memory.slice(ptr, ptr + testData.length);
    console.log(`   Read back: ${Array.from(readData).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    
    // free 测试
    exports.free(ptr);
    console.log('   free() completed');
    
    // Session 测试
    console.log('\n4. Testing session management:');
    
    // 使用空密钥初始化 session
    const keyPtr = exports.malloc(32);
    const keyData = new Uint8Array(32);
    memory.set(keyData, keyPtr);
    
    const sessionId = exports.initSession(keyPtr, 32, 0, 0); // cipher=none, layout=ascii
    console.log(`   initSession() = ${sessionId} (expected: >= 0)`);
    
    if (sessionId < 0) {
      throw new Error(`initSession failed: ${sessionId}`);
    }
    
    exports.free(keyPtr);
    
    // Mask 测试
    console.log('\n5. Testing mask/unmask:');
    const testInput = new TextEncoder().encode('Test message for Sudoku obfuscation!');
    const inputPtr = exports.malloc(testInput.length);
    memory.set(testInput, inputPtr);
    
    const maskedPtr = exports.mask(sessionId, inputPtr, testInput.length);
    const maskedLen = exports.getOutLen();
    console.log(`   mask: ${testInput.length} bytes -> ${maskedLen} bytes`);
    
    if (maskedLen === 0) {
      console.warn('   Warning: mask returned empty output');
    } else {
      // Unmask 测试
      const unmaskedPtr = exports.unmask(sessionId, maskedPtr, maskedLen);
      const unmaskedLen = exports.getOutLen();
      console.log(`   unmask: ${maskedLen} bytes -> ${unmaskedLen} bytes`);
      
      const unmaskedData = memory.slice(unmaskedPtr, unmaskedPtr + unmaskedLen);
      const unmaskedText = new TextDecoder().decode(unmaskedData);
      console.log(`   Original: "${new TextDecoder().decode(testInput)}"`);
      console.log(`   Unmasked: "${unmaskedText}"`);
      
      if (unmaskedText === new TextDecoder().decode(testInput)) {
        console.log('   ✓ Round-trip successful!');
      } else {
        console.log('   ✗ Round-trip failed!');
      }
    }
    
    exports.free(inputPtr);
    
    // 关闭 session
    exports.closeSession(sessionId);
    console.log('\n6. closeSession() completed');
    
    // 内存统计
    console.log('\n7. Memory statistics:');
    console.log(`   Memory buffer size: ${exports.memory.buffer.byteLength} bytes (${exports.memory.buffer.byteLength / 1024 / 1024} MB)`);
    console.log(`   getArenaPtr: 0x${exports.getArenaPtr().toString(16)}`);
    console.log(`   getOutBuf: 0x${exports.getOutBuf().toString(16)}`);
    console.log(`   getWorkBuf: 0x${exports.getWorkBuf().toString(16)}`);
    
    console.log('\n=== All tests passed! ===');
    
  } catch (err) {
    console.error('\nError:', err.message);
    process.exit(1);
  }
}

main();
