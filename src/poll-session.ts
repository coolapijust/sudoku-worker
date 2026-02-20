/**
 * Poll 模式会话管理
 */

import { SudokuAEAD } from './sudoku-aead';

export interface Session {
  id: string;
  aead: SudokuAEAD;
  upstreamSocket: Socket | null;
  pullBuffer: Uint8Array[];
  pushBuffer: Uint8Array[];
  lastActivity: number;
  closed: boolean;
}

// 简单的内存会话存储（生产环境应该用 Redis 或 Durable Objects）
const sessions = new Map<string, Session>();

export function createSession(id: string, aead: SudokuAEAD): Session {
  const session: Session = {
    id,
    aead,
    upstreamSocket: null,
    pullBuffer: [],
    pushBuffer: [],
    lastActivity: Date.now(),
    closed: false,
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  const session = sessions.get(id);
  if (session) {
    session.lastActivity = Date.now();
  }
  return session;
}

export function deleteSession(id: string): void {
  const session = sessions.get(id);
  if (session) {
    session.closed = true;
    if (session.upstreamSocket) {
      try {
        session.upstreamSocket.close();
      } catch (e) {}
    }
    sessions.delete(id);
  }
}

// 清理过期会话（每 5 分钟运行一次）
export function cleanupSessions(maxAgeMs: number = 5 * 60 * 1000): void {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActivity > maxAgeMs || session.closed) {
      deleteSession(id);
    }
  }
}

// 生成会话 ID
export function generateSessionId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}
