/**
 * Sudoku 协议握手处理模块
 */

import { SudokuAEAD } from './sudoku-aead';

export async function handleSudokuHandshake(
  ws: WebSocket,
  aead: SudokuAEAD,
  timeoutMs: number = 5000,
  messageBuffer: ArrayBuffer[] = []
): Promise<{ success: boolean; error?: string }> {
  console.log('[Handshake] Starting handshake process...');
  console.log(`[Handshake] Pre-buffered messages: ${messageBuffer.length}`);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error('[Handshake] Timeout waiting for client handshake');
      resolve({ success: false, error: 'Handshake timeout' });
    }, timeoutMs);

    let handshakeReceived = false;
    let modeReceived = false;

    const processHandshake = async (data: ArrayBuffer) => {
      if (handshakeReceived) return;
      handshakeReceived = true;

      console.log('[Handshake] Processing handshake data');
      console.log(`[Handshake] Message size: ${data.byteLength} bytes`);

      try {
        const handshakePlain = await aead.unmaskAndDecrypt(new Uint8Array(data));
        console.log(`[Handshake] Decrypted handshake length: ${handshakePlain.length}`);

        if (handshakePlain.length < 16) {
          clearTimeout(timer);
          console.error(`[Handshake] Invalid handshake length: ${handshakePlain.length}, expected >= 16`);
          resolve({ success: false, error: 'Invalid handshake length' });
          return;
        }

        const timestamp = new DataView(handshakePlain.buffer).getBigUint64(0, false);
        const now = BigInt(Math.floor(Date.now() / 1000));
        const diff = now > timestamp ? now - timestamp : timestamp - now;

        console.log(`[Handshake] Client timestamp: ${timestamp}, Server time: ${now}, Diff: ${diff}s`);

        if (diff > 60n) {
          clearTimeout(timer);
          console.error(`[Handshake] Time skew too large: ${diff}s`);
          resolve({ success: false, error: 'Time skew/replay' });
          return;
        }

        console.log('[Handshake] Timestamp verified');

        if (handshakePlain.length >= 17) {
          const clientMode = handshakePlain[16];
          const serverMode = 0x02;

          console.log(`[Handshake] Client mode: ${clientMode}, Server mode: ${serverMode}`);

          if (clientMode !== serverMode) {
            clearTimeout(timer);
            console.error(`[Handshake] Mode mismatch: client=${clientMode}, server=${serverMode}`);
            resolve({ success: false, error: `Mode mismatch: client=${clientMode}, server=${serverMode}` });
            return;
          }

          clearTimeout(timer);
          console.log('[Handshake] Handshake successful (mode in same message)');
          resolve({ success: true });
        } else {
          console.log('[Handshake] Waiting for mode byte...');
          const bufferedMode = messageBuffer.find((_, i) => i > 0);
          if (bufferedMode) {
            console.log('[Handshake] Found buffered mode message');
            await processMode(bufferedMode);
            return;
          }
        }
      } catch (err) {
        clearTimeout(timer);
        console.error('[Handshake] Handshake decrypt failed:', err);
        resolve({ success: false, error: `Handshake decrypt failed: ${err}` });
      }
    };

    const processMode = async (data: ArrayBuffer) => {
      if (modeReceived) return;
      modeReceived = true;

      try {
        const modePlain = await aead.unmaskAndDecrypt(new Uint8Array(data));
        console.log(`[Handshake] Decrypted mode length: ${modePlain.length}`);

        if (modePlain.length < 1) {
          clearTimeout(timer);
          console.error('[Handshake] Invalid mode length');
          resolve({ success: false, error: 'Invalid mode length' });
          return;
        }

        const clientMode = modePlain[0];
        const serverMode = 0x02;

        console.log(`[Handshake] Client mode: ${clientMode}, Server mode: ${serverMode}`);

        if (clientMode !== serverMode) {
          clearTimeout(timer);
          console.error(`[Handshake] Mode mismatch: client=${clientMode}, server=${serverMode}`);
          resolve({ success: false, error: `Mode mismatch: client=${clientMode}, server=${serverMode}` });
          return;
        }

        clearTimeout(timer);
        console.log('[Handshake] Handshake successful');
        resolve({ success: true });
      } catch (err) {
        clearTimeout(timer);
        console.error('[Handshake] Mode decrypt failed:', err);
        resolve({ success: false, error: `Mode decrypt failed: ${err}` });
      }
    };

    if (messageBuffer.length > 0) {
      console.log('[Handshake] Processing buffered handshake message');
      processHandshake(messageBuffer[0]);
    }

    const messageHandler = async (event: MessageEvent) => {
      const data = event.data as ArrayBuffer;
      if (!handshakeReceived) {
        await processHandshake(data);
      } else if (!modeReceived) {
        await processMode(data);
      }
    };

    ws.addEventListener('message', messageHandler);
  });
}
