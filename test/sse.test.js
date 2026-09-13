import test from 'node:test';
import assert from 'node:assert/strict';
import { readEvents } from '../src/sse.js';

async function parse(chunks) {
  const stream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
  return Array.fromAsync(readEvents(stream));
}
test('SSE frames survive split UTF-8 and CRLF boundaries, while heartbeat and incomplete data are ignored', async () => {
  const text = ': hb\r\nevent: snapshot\r\ndata: {"label":"端末"}\r\n\r\nevent: stats\r\ndata: first\r\ndata: second\r\n\r\nevent: stats\ndata: incomplete';
  const bytes = new TextEncoder().encode(text);
  const frames = await parse(Array.from(bytes, (byte) => Uint8Array.of(byte)));
  assert.deepEqual(frames, [
    { event: 'snapshot', data: '{"label":"端末"}' },
    { event: 'stats', data: 'first\nsecond' },
  ]);
});
test('a lone CR terminates an SSE frame without requiring a later frame', async () => {
  assert.deepEqual(await parse([new TextEncoder().encode('event: stats\rdata: complete\r\r')]), [{ event: 'stats', data: 'complete' }]);
});
