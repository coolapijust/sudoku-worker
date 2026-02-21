/**
 * Poll 模式 HTTP Tunnel 处理器
 */

import { Env } from './index';
import { TunnelAuth, TunnelMode, extractAuth } from './auth';
import { createSession, getSession, deleteSession, generateSessionId, notifyData, waitForData } from './poll-session';
import { SudokuAEAD, hexToBytes, getCipherType, getLayoutType } from './sudoku-aead';
import { connect } from 'cloudflare:sockets';
import { parseTargetAddress } from './address';

// 默认配置
const DEFAULT_UPSTREAM_PORT = 443;

/**
 * Base64 字符串转 Uint8Array 助手
 */
function base64ToBytes(base64: string): Uint8Array {
  const binaryString = atob(base64.trim());
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}


/**
 * 处理 /session 端点 - 初始化会话
 */
export async function handleSession(
  request: Request,
  env: Env,
  wasm: any
): Promise<Response> {
  // 允许 GET 和 POST 方法
  if (request.method !== 'POST' && request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // 检查环境变量
  if (!env.SUDOKU_KEY) {
    return new Response('SUDOKU_KEY not configured', { status: 500 });
  }

  // 验证认证 - 使用实际请求方法
  const auth = new TunnelAuth(env.SUDOKU_KEY);
  const { header, query } = extractAuth(request);
  const isValid = await auth.verify(header, query, 'poll', request.method, '/session');
  if (!isValid) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // 初始化 Sudoku 会话
    const keyHex = env.SUDOKU_KEY;
    const keyBytes = hexToBytes(keyHex);

    const keyPtr = wasm.arenaMalloc(keyBytes.length);
    if (!keyPtr) {
      return new Response('Memory error', { status: 500 });
    }

    const memory = new Uint8Array(wasm.memory.buffer);
    memory.set(keyBytes, keyPtr);

    const cipherType = getCipherType(env.CIPHER_METHOD || 'aes-128-gcm');
    const layoutType = getLayoutType(env.LAYOUT_MODE || 'ascii');

    const sessionId = wasm.initSession(keyPtr, keyBytes.length, cipherType, layoutType);
    if (sessionId < 0) {
      wasm.arenaFree(keyPtr);
      return new Response(`Init failed: ${sessionId}`, { status: 500 });
    }

    const aead = new SudokuAEAD(wasm, sessionId, keyBytes);

    // 创建会话
    const httpSessionId = generateSessionId();
    const session = createSession(httpSessionId, aead);
    session.standaloneMode = !env.UPSTREAM_HOST || (env as any).STANDALONE_PROXY === 'true';

    // 连接到上游（如果不是独立代理模式且配置了上游）
    if (!session.standaloneMode && env.UPSTREAM_HOST) {
      try {
        session.upstreamSocket = connect({
          hostname: env.UPSTREAM_HOST,
          port: DEFAULT_UPSTREAM_PORT
        });
        session.upstreamWriter = session.upstreamSocket.writable.getWriter();

        // 启动上游读取循环
        handleUpstreamRead(session);
      } catch (err) {
        deleteSession(httpSessionId);
        wasm.closeSession(sessionId);
        wasm.arenaFree(keyPtr);
        return new Response('Upstream connect failed', { status: 502 });
      }
    }

    // 返回 token=xxx 格式（与原始协议兼容）
    const token = httpSessionId;
    const body = `token=${token}`;

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': body.length.toString(),
        'Cache-Control': 'no-store, no-transform'
      },
    });
  } catch (err) {
    return new Response(`Error: ${err}`, { status: 500 });
  }
}

/**
 * 处理 /stream 端点 - Pull 数据 (长轮询模式)
 *
 * 设计：
 * - 若 pullBuffer 中没有数据，则挂起等待（最长 25s），避免 100ms 内断流导致 Clash 管道崩溃。
 * - 每 5s 发送一行空心跳（\n），防止 Cloudflare 因空闲连接提前关闭。
 * - Cloudflare Worker 请求限制 ~30s CPU，25s 超时后优雅关闭，让客户端续期重连。
 * - 连接关闭或 session 关闭时立即退出循环。
 */
export async function handleStream(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const url = new URL(request.url);
  const token = url.searchParams.get('token') || url.searchParams.get('session');
  if (!token) {
    return new Response('Missing session', { status: 400 });
  }

  const auth = new TunnelAuth(env.SUDOKU_KEY);
  const { header, query } = extractAuth(request);
  const isValid = await auth.verify(header, query, 'poll', 'GET', '/stream');
  if (!isValid) {
    return new Response('Unauthorized', { status: 401 });
  }

  const session = getSession(token);
  if (!session || session.closed) {
    return new Response('Session not found', { status: 404 });
  }

  // 长轮询逻辑：最多挂起 25s，期间每 5s 发心跳
  const LONG_POLL_TIMEOUT_MS = 25_000;
  const HEARTBEAT_INTERVAL_MS = 5_000;
  const startTime = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        while (!session.closed) {
          const elapsed = Date.now() - startTime;
          const remaining = LONG_POLL_TIMEOUT_MS - elapsed;
          if (remaining <= 0) break; // 超时，让客户端续期重连

          // 若有数据，立即全部推送
          if (session.pullBuffer.length > 0) {
            while (session.pullBuffer.length > 0) {
              const data = session.pullBuffer.shift()!;
              const base64 = btoa(String.fromCharCode(...data));
              controller.enqueue(encoder.encode(base64 + '\n'));
            }
            // 推送完数据后继续等待（不立即关闭，让同一个 /stream 连接继续服务）
          } else {
            // 无数据：等待信号或心跳超时（取两者较小值）
            const waitTime = Math.min(remaining, HEARTBEAT_INTERVAL_MS);
            await waitForData(session, waitTime);

            // 等待结束后：如果仍然没有数据，发一行心跳保活
            if (session.pullBuffer.length === 0 && !session.closed) {
              controller.enqueue(encoder.encode('\n'));
            }
          }
        }
      } catch (err) {
        controller.error(err);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-store, no-transform',
    },
  });
}


/**
 * 处理 /api/v1/upload 端点 - Push 数据
 */
export async function handleUpload(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // 获取 token（支持 token 和 session 参数）
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || url.searchParams.get('session');
  if (!token) {
    return new Response('Missing session', { status: 400 });
  }

  // 验证认证
  const auth = new TunnelAuth(env.SUDOKU_KEY);
  const { header, query } = extractAuth(request);
  const isValid = await auth.verify(header, query, 'poll', 'POST', '/api/v1/upload');
  if (!isValid) {
    return new Response('Unauthorized', { status: 401 });
  }

  const session = getSession(token);
  if (!session || session.closed) {
    return new Response('Session not found', { status: 404 });
  }

  try {
    const bodyText = await request.text();
    const lines = bodyText.split('\n').filter(line => line.trim().length > 0);

    if (lines.length === 0) {
      return new Response('OK', { status: 200 });
    }

    console.log(`[Upload] Received ${lines.length} lines from client`);

    // 1. 解码所有 Base64 行并合并为原始混淆数据
    const decodedChunks: Uint8Array[] = [];
    let totalDecodedLen = 0;
    for (const line of lines) {
      try {
        const b = base64ToBytes(line);
        decodedChunks.push(b);
        totalDecodedLen += b.length;
      } catch (e) {
        console.error('[Upload] Base64 decode failed:', e);
      }
    }

    const totalRaw = new Uint8Array(totalDecodedLen);
    let offset = 0;
    for (const chunk of decodedChunks) {
      totalRaw.set(chunk, offset);
      offset += chunk.length;
    }

    // 2. 整体去混淆并存入会话缓冲区 (Poll 模式必须流式处理)
    const unmasked = session.aead.unmask(totalRaw);
    const newPushBuffer = new Uint8Array(session.pushUnmasked.length + unmasked.length);
    newPushBuffer.set(session.pushUnmasked);
    newPushBuffer.set(unmasked, session.pushUnmasked.length);
    session.pushUnmasked = newPushBuffer;

    // 3. 循环解析完整的 AEAD 帧
    while (session.pushUnmasked.length >= 2) {
      const frameLen = (session.pushUnmasked[0] << 8) | session.pushUnmasked[1];
      if (session.pushUnmasked.length < 2 + frameLen) {
        break; // 数据不足一个完整帧，等待后续上传
      }

      // 提取一帧进行解密
      const frame = session.pushUnmasked.subarray(0, 2 + frameLen);
      const decrypted = session.aead.decrypt(frame);

      // 滑动缓冲区窗口
      session.pushUnmasked = session.pushUnmasked.slice(2 + frameLen);

      if (!decrypted) {
        console.error(`[Upload] Decryption failed for frame (expected len: ${frameLen})`);
        continue;
      }

      // 4. 处理解密后的明文 (Standalone SOCKS5 握手逻辑)
      if (session.standaloneMode && !session.socks5ConnectDone) {
        const merged = new Uint8Array(session.bufferOffset.length + decrypted.length);
        merged.set(session.bufferOffset);
        merged.set(decrypted, session.bufferOffset.length);
        session.bufferOffset = merged;

        // 阶段 1: SOCKS5 Greeting (VER NMETHODS METHODS)
        if (!session.socks5GreetingDone) {
          if (session.bufferOffset.length < 3) continue; // 等待更多数据
          if (session.bufferOffset[0] !== 0x05) {
            console.error('[SOCKS5] Invalid version in greeting');
            deleteSession(session.id);
            return new Response('Invalid SOCKS5', { status: 400 });
          }

          console.log('[SOCKS5] Handling Greeting');
          session.socks5GreetingDone = true;
          session.bufferOffset = session.bufferOffset.slice(3); // 简单处理，假设 0x05 0x01 0x00

          // 回复 0x05 0x00 (No Auth)
          const reply = session.aead.encrypt(new Uint8Array([0x05, 0x00]));
          if (reply) notifyData(session, reply);

          // 如果还有剩余数据，继续处理（可能是紧随其后的 Connect 请求）
          if (session.bufferOffset.length === 0) continue;
        }

        // 阶段 2: SOCKS5 Connect 请求 (VER CMD RSV ATYP ADDR PORT)
        if (!session.socks5ConnectDone) {
          if (session.bufferOffset.length < 10) continue;

          // 跳过前 3 字节 (VER CMD RSV) 解析地址
          const target = parseTargetAddress(session.bufferOffset.subarray(3));
          if (!target) continue;

          console.log(`[SOCKS5] Target: ${target.hostname}:${target.port}`);
          session.socks5ConnectDone = true;
          session.targetParsed = true; // 复用旧标志

          // 回复 Success: VER(0x05) REP(0x00) RSV(0x00) ATYP(0x01) BND.ADDR(0x00*4) BND.PORT(0x00*2)
          const successReply = session.aead.encrypt(new Uint8Array([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (successReply) notifyData(session, successReply);

          try {
            console.log(`[Standalone] Connecting to remote host...`);
            session.upstreamSocket = connect({ hostname: target.hostname, port: target.port });
            session.upstreamWriter = session.upstreamSocket.writable.getWriter();

            handleUpstreamRead(session);

            const remainingData = session.bufferOffset.subarray(3 + target.byteLength);
            session.bufferOffset = new Uint8Array(0);
            if (remainingData.length > 0) {
              await session.upstreamWriter.write(remainingData);
            }
          } catch (e) {
            console.error(`[Standalone] Connect failed: ${e}`);
            deleteSession(session.id);
            return new Response('Target connect failed', { status: 502 });
          }
        }
      } else {
        if (session.upstreamWriter) {
          await session.upstreamWriter.write(decrypted);
        }
      }
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('[Upload] Error:', err);
    return new Response(`Error: ${err}`, { status: 500 });
  }
}


/**
 * 处理 /fin 端点 - 结束写入
 */
export async function handleFin(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // 获取 token（支持 token 和 session 参数）
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || url.searchParams.get('session');
  if (!token) {
    return new Response('Missing session', { status: 400 });
  }

  const session = getSession(token);
  if (!session || session.closed) {
    return new Response('Session not found', { status: 404 });
  }

  // 关闭上游写入端
  if (session.upstreamWriter) {
    session.upstreamWriter.close();
  } else if (session.upstreamSocket) {
    session.upstreamSocket.close();
  }

  return new Response('OK', { status: 200 });
}

/**
 * 处理 /close 端点 - 关闭会话
 */
export async function handleClose(
  request: Request,
  env: Env,
  wasm: any
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // 获取 token（支持 token 和 session 参数）
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || url.searchParams.get('session');
  if (!token) {
    return new Response('Missing session', { status: 400 });
  }

  const session = getSession(token);
  if (!session || session.closed) {
    return new Response('Session not found', { status: 404 });
  }

  // 关闭会话
  session.closed = true;
  if (session.upstreamWriter) {
    try { session.upstreamWriter.close(); } catch (e) { }
  }
  if (session.upstreamSocket) {
    try { session.upstreamSocket.close(); } catch (e) { }
  }
  deleteSession(token);

  return new Response('OK', { status: 200 });
}

/**
 * 处理上游读取，数据就绪后通过 notifyData 唤醒等待中的 /stream 长轮询。
 */
async function handleUpstreamRead(session: any): Promise<void> {
  if (!session.upstreamSocket) return;

  try {
    const reader = session.upstreamSocket.readable.getReader();

    while (!session.closed) {
      const { done, value } = await reader.read();
      if (done) {
        console.log('[Upstream] EOF reached');
        break;
      }

      console.log(`[Upstream] Read ${value.length} bytes from remote`);

      // 加密数据后，通过 notifyData 推入 pullBuffer 并唤醒 /stream
      const encrypted = session.aead.encrypt(value);
      if (encrypted) {
        notifyData(session, encrypted);
      }

    }
  } catch (err) {
    console.error('[Upstream] Read error:', err);
  } finally {
    session.closed = true;
    // 确保等待中的 /stream 能感知到 session 已关闭
    if (session.dataNotify) {
      const fn = session.dataNotify;
      session.dataNotify = null;
      fn();
    }
  }
}
