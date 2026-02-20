/**
 * Sudoku 协议握手处理模块
 */

import { SudokuAEAD } from './sudoku-aead';

export async function handleSudokuHandshake(
  ws: WebSocket,
  aead: SudokuAEAD,
  timeoutMs: number = 5000
): Promise<{ success: boolean; error?: string }> {
  console.log('[Handshake] Starting handshake process...');

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error('[Handshake] Timeout waiting for client handshake');
      resolve({ success: false, error: 'Handshake timeout' });
    }, timeoutMs);

    let handshakeReceived = false;

    const messageHandler = async (event: MessageEvent) => {
      if (handshakeReceived) return;
      handshakeReceived = true;

      console.log('[Handshake] Received first message from client');

      try {
        const data = event.data as ArrayBuffer;
        console.log(`[Handshake] Message size: ${data.byteLength} bytes`);

        const handshakePlain = await aead.unmaskAndDecrypt(new Uint8Array(data));
        console.log(`[Handshake] Decrypted handshake length: ${handshakePlain.length}`);

        if (handshakePlain.length < 16) {
          clearTimeout(timer);
          ws.removeEventListener('message', messageHandler);
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
          ws.removeEventListener('message', messageHandler);
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
            ws.removeEventListener('message', messageHandler);
            console.error(`[Handshake] Mode mismatch: client=${clientMode}, server=${serverMode}`);
            resolve({ success: false, error: `Mode mismatch: client=${clientMode}, server=${serverMode}` });
            return;
          }

          clearTimeout(timer);
          ws.removeEventListener('message', messageHandler);
          console.log('[Handshake] Handshake successful (mode in same message)');
          resolve({ success: true });
        } else {
          console.log('[Handshake] Waiting for mode byte...');

          const modeHandler = async (modeEvent: MessageEvent) => {
            try {
              const modeData = modeEvent.data as ArrayBuffer;
              console.log(`[Handshake] Mode message size: ${modeData.byteLength} bytes`);

              const modePlain = await aead.unmaskAndDecrypt(new Uint8Array(modeData));
              console.log(`[Handshake] Decrypted mode length: ${modePlain.length}`);

              if (modePlain.length < 1) {
                clearTimeout(timer);
                ws.removeEventListener('message', messageHandler);
                console.error('[Handshake] Invalid mode length');
                resolve({ success: false, error: 'Invalid mode length' });
                return;
              }

              const clientMode = modePlain[0];
              const serverMode = 0x02;

              console.log(`[Handshake] Client mode: ${clientMode}, Server mode: ${serverMode}`);

              if (clientMode !== serverMode) {
                clearTimeout(timer);
                ws.removeEventListener('message', messageHandler);
                console.error(`[Handshake] Mode mismatch: client=${clientMode}, server=${serverMode}`);
                resolve({ success: false, error: `Mode mismatch: client=${clientMode}, server=${serverMode}` });
                return;
              }

              clearTimeout(timer);
              ws.removeEventListener('message', messageHandler);
              console.log('[Handshake] Handshake successful');
              resolve({ success: true });
            } catch (err) {
              clearTimeout(timer);
              ws.removeEventListener('message', messageHandler);
              console.error('[Handshake] Mode decrypt failed:', err);
              resolve({ success: false, error: `Mode decrypt failed: ${err}` });
            }
          };

          ws.addEventListener('message', modeHandler, { once: true });
        }
      } catch (err) {
        clearTimeout(timer);
        ws.removeEventListener('message', messageHandler);
        console.error('[Handshake] Handshake decrypt failed:', err);
        resolve({ success: false, error: `Handshake decrypt failed: ${err}` });
      }
    };

    ws.addEventListener('message', messageHandler);
  });
}
