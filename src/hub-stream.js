import { createParser } from 'eventsource-parser';
import { setTimeout as delay } from 'node:timers/promises';

export function connectHub(hub, { onEvent, onConnection, reconnectMs = 3000 }) {
  const controller = new AbortController();
  const { signal } = controller;
  const done = (async () => {
    while (!signal.aborted) {
      let reader;
      try {
        const response = await fetch(`${hub.url}/api/stats/stream`, {
          headers: { Authorization: `Bearer ${hub.secret}`, Accept: 'text/event-stream' },
          redirect: 'error', signal
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Hub SSE: HTTP ${response.status}`);
        }
        if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
          await response.body?.cancel();
          throw new Error('Hub SSE: Content-Type が text/event-stream ではありません。');
        }
        onConnection(true, null);
        const parser = createParser({ onEvent(event) {
          if (!signal.aborted && ['snapshot', 'stats'].includes(event.event)) onEvent(event.data, new Date().toISOString());
        } });
        const decoder = new TextDecoder();
        reader = response.body.getReader();
        while (!signal.aborted) {
          const { value, done: ended } = await reader.read();
          if (ended) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        if (!signal.aborted) onConnection(false, 'Hub の SSE 接続が切断されました。');
      } catch (error) {
        if (!signal.aborted) onConnection(false, error.message);
      } finally {
        if (reader) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      if (!signal.aborted) await delay(reconnectMs, undefined, { signal }).catch(error => {
        if (error.name !== 'AbortError') throw error;
      });
    }
  })();
  return { async stop() { controller.abort(); await done; } };
}
