/**
 * Poll 模式 HTTP Tunnel 处理器
 */

import { Env } from './index';
import { TunnelAuth, TunnelMode, extractAuth } from './auth';
import { createSession, getSession, deleteSession, generateSessionId } from './poll-session';
import { SudokuAEAD, hexToBytes, getCipherType, getLayoutType } from './sudoku-aead';
import { connect } from 'cloudflare:sockets';

// 默认配置
const DEFAULT_UPSTREAM_PORT = 443;

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

    // 连接到上游（如果配置了）
    if (env.UPSTREAM_HOST) {
      try {
        session.upstreamSocket = connect({
          hostname: env.UPSTREAM_HOST,
          port: DEFAULT_UPSTREAM_PORT
        });

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
 * 处理 /stream 端点 - Pull 数据
 */
export async function handleStream(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== 'GET') {
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
  const isValid = await auth.verify(header, query, 'poll', 'GET', '/stream');
  if (!isValid) {
    return new Response('Unauthorized', { status: 401 });
  }

  const session = getSession(token);
  if (!session || session.closed) {
    return new Response('Session not found', { status: 404 });
  }

  // 创建 ReadableStream，从 pullBuffer 中读取数据
  const stream = new ReadableStream({
    start(controller) {
      const sendData = async () => {
        try {
          while (session.pullBuffer.length > 0) {
            const data = session.pullBuffer.shift()!;
            // Base64 编码
            const base64 = btoa(String.fromCharCode(...data));
            controller.enqueue(new TextEncoder().encode(base64 + '\n'));
          }

          // 如果没有数据，等待一段时间后关闭
          setTimeout(() => {
            controller.close();
          }, 100);
        } catch (err) {
          controller.error(err);
        }
      };

      sendData();
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
    // 读取请求体数据
    const data = new Uint8Array(await request.arrayBuffer());

    // 解密数据
    const decrypted = session.aead.decrypt(data);
    if (!decrypted) {
      return new Response('Decryption failed', { status: 400 });
    }

    // 发送到上游
    if (session.upstreamSocket) {
      await session.upstreamSocket.write(decrypted);
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
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
  if (session.upstreamSocket) {
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
  if (session.upstreamSocket) {
    session.upstreamSocket.close();
  }
  deleteSession(token);

  return new Response('OK', { status: 200 });
}

/**
 * 处理上游读取
 */
async function handleUpstreamRead(session: any): Promise<void> {
  if (!session.upstreamSocket) return;

  try {
    const reader = session.upstreamSocket.readable.getReader();

    while (!session.closed) {
      const { done, value } = await reader.read();
      if (done) break;

      // 加密数据
      const encrypted = session.aead.encrypt(value);
      if (encrypted) {
        session.pullBuffer.push(encrypted);
      }
    }
  } catch (err) {
    console.error('[Upstream] Read error:', err);
  } finally {
    session.closed = true;
  }
}
