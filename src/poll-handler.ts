/**
 * Poll 模式 HTTP Tunnel 处理器
 */

import { Env } from './index';
import { TunnelAuth, TunnelMode, extractAuth } from './auth';
import { createSession, getSession, deleteSession, generateSessionId } from './poll-session';
import { SudokuAEAD, hexToBytes, getCipherType, getLayoutType } from './sudoku-aead';
import { connect } from 'cloudflare:sockets';

const UPSTREAM_HOST = '127.0.0.1'; // 从环境变量获取
const UPSTREAM_PORT = 443;

/**
 * 处理 /session 端点 - 初始化会话
 */
export async function handleSession(
  request: Request,
  env: Env,
  wasm: any
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // 验证认证
  const auth = new TunnelAuth(env.SUDOKU_KEY);
  const { header, query } = extractAuth(request);
  const isValid = await auth.verify(header, query, 'poll', 'POST', '/session');
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

    // 连接到上游
    try {
      const upstreamHost = env.UPSTREAM_HOST || UPSTREAM_HOST;
      session.upstreamSocket = connect({ hostname: upstreamHost, port: UPSTREAM_PORT });
      
      // 启动上游读取循环
      handleUpstreamRead(session);
    } catch (err) {
      deleteSession(httpSessionId);
      wasm.closeSession(sessionId);
      wasm.arenaFree(keyPtr);
      return new Response('Upstream connect failed', { status: 502 });
    }

    // 生成响应 URL
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    const response = {
      session_id: httpSessionId,
      push_url: `${baseUrl}/api/v1/upload?session=${httpSessionId}`,
      pull_url: `${baseUrl}/stream?session=${httpSessionId}`,
      fin_url: `${baseUrl}/fin?session=${httpSessionId}`,
      close_url: `${baseUrl}/close?session=${httpSessionId}`,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
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

  // 获取会话 ID
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session');
  if (!sessionId) {
    return new Response('Missing session', { status: 400 });
  }

  // 验证认证
  const auth = new TunnelAuth(env.SUDOKU_KEY);
  const { header, query } = extractAuth(request);
  const isValid = await auth.verify(header, query, 'poll', 'GET', '/stream');
  if (!isValid) {
    return new Response('Unauthorized', { status: 401 });
  }

  const session = getSession(sessionId);
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
      'Cache-Control': 'no-cache',
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

  // 获取会话 ID
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session');
  if (!sessionId) {
    return new Response('Missing session', { status: 400 });
  }

  // 验证认证
  const auth = new TunnelAuth(env.SUDOKU_KEY);
  const { header, query } = extractAuth(request);
  const isValid = await auth.verify(header, query, 'poll', 'POST', '/api/v1/upload');
  if (!isValid) {
    return new Response('Unauthorized', { status: 401 });
  }

  const session = getSession(sessionId);
  if (!session || session.closed) {
    return new Response('Session not found', { status: 404 });
  }

  try {
    // 读取请求体（Base64 编码的行）
    const body = await request.text();
    const lines = body.split('\n').filter(line => line.trim());

    for (const line of lines) {
      // Base64 解码
      const binary = atob(line.trim());
      const data = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        data[i] = binary.charCodeAt(i);
      }

      // 解密并发送到上游
      const plaintext = await session.aead.unmaskAndDecrypt(data);
      if (session.upstreamSocket) {
        await session.upstreamSocket.write(plaintext);
      }
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

  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session');
  if (!sessionId) {
    return new Response('Missing session', { status: 400 });
  }

  const auth = new TunnelAuth(env.SUDOKU_KEY);
  const { header, query } = extractAuth(request);
  const isValid = await auth.verify(header, query, 'poll', 'POST', '/fin');
  if (!isValid) {
    return new Response('Unauthorized', { status: 401 });
  }

  const session = getSession(sessionId);
  if (!session) {
    return new Response('Session not found', { status: 404 });
  }

  // 关闭上游写入端
  if (session.upstreamSocket) {
    try {
      // 注意：Cloudflare Socket 没有直接关闭写入的方法
      // 这里只是标记状态
    } catch (e) {}
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

  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session');
  if (!sessionId) {
    return new Response('Missing session', { status: 400 });
  }

  const auth = new TunnelAuth(env.SUDOKU_KEY);
  const { header, query } = extractAuth(request);
  const isValid = await auth.verify(header, query, 'poll', 'POST', '/close');
  if (!isValid) {
    return new Response('Unauthorized', { status: 401 });
  }

  const session = getSession(sessionId);
  if (session) {
    deleteSession(sessionId);
  }

  return new Response('OK', { status: 200 });
}

/**
 * 处理上游数据读取
 */
async function handleUpstreamRead(session: import('./poll-session').Session): Promise<void> {
  if (!session.upstreamSocket) return;

  try {
    const reader = session.upstreamSocket.readable.getReader();
    while (!session.closed) {
      const { done, value } = await reader.read();
      if (done) break;

      // 加密数据并放入 pullBuffer
      const encrypted = await session.aead.encryptAndMask(value);
      session.pullBuffer.push(encrypted);
    }
  } catch (err) {
    // 上游连接错误
  }
}
