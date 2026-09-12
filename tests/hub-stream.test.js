import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { connectHub } from '../src/hub-stream.js';

test('SSE transport handles split UTF-8, CRLF, multiline data and discards unfinished events', { timeout: 5000 }, async () => {
  let response;
  const server = createServer((request, res) => {
    assert.equal(request.headers.authorization, 'Bearer test-secret');
    response = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const connected = Promise.withResolvers();
  const received = Promise.withResolvers();
  const events = [];
  const connection = connectHub({ url: `http://127.0.0.1:${server.address().port}`, secret: 'test-secret' }, {
    onConnection(value) { if (value) connected.resolve(); },
    onEvent(data) { events.push(data); received.resolve(); }
  });
  try {
    await connected.promise;
    const bytes = Buffer.from(': heartbeat\r\nevent: stats\r\ndata: {"hostname":\r\ndata: "端末"}\r\n\r\n');
    for (let i = 0; i < bytes.length; i += 2) response.write(bytes.subarray(i, i + 2));
    await received.promise;
    assert.deepEqual(events.map(JSON.parse), [{ hostname: '端末' }]);
    response.write('event: stats\ndata: {"unfinished":true}');
    await connection.stop();
    assert.equal(events.length, 1);
  } finally {
    await connection.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('redirected Hub requests never forward the secret to another endpoint', { timeout: 5000 }, async () => {
  let destinationRequests = 0;
  const destination = createServer((request, response) => { destinationRequests++; response.end(); });
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  const origin = createServer((request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/api/stats/stream` });
    response.end();
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const rejected = Promise.withResolvers();
  const connection = connectHub({ url: `http://127.0.0.1:${origin.address().port}`, secret: 'test-secret' }, {
    onEvent() { assert.fail('redirect must not produce data'); },
    onConnection(connected, error) { if (!connected && error) rejected.resolve(); }
  });
  try {
    await rejected.promise;
    assert.equal(destinationRequests, 0);
  } finally {
    await connection.stop();
    for (const server of [origin, destination]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
