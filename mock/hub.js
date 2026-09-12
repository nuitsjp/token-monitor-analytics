import { createServer } from 'node:http';
import { makeStats } from './fixture.js';

function isAuthorized(request, secret) {
  const authorization = request.headers.authorization;
  const token = request.headers['x-token-monitor-secret'];
  return authorization === `Bearer ${secret}` || token === secret;
}

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

function eventText(event, data) {
  const eventName = String(event);
  const value = String(typeof data === 'string' ? data : JSON.stringify(data) ?? '');
  const dataLines = value.split(/\r\n|\r|\n/).map((line) => `data: ${line}`).join('\n');
  return `event: ${eventName}\n${dataLines}\n\n`;
}

function isDirectCliInvocation() {
  const entry = String(process.argv[1] || '').replaceAll('\\', '/');
  return entry.endsWith('/mock/hub.js');
}

export function createMockHub({ secret = 'mock-secret', stats = makeStats(), heartbeatMs = 30000, port = 0 } = {}) {
  let currentStats = stats;
  const connections = new Set();
  const heartbeatInterval = Number(heartbeatMs);

  function removeConnection(connection) {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.timer) clearInterval(connection.timer);
    connections.delete(connection);
  }

  function closeConnection(connection) {
    removeConnection(connection);
    try { connection.response.end(); } catch (_) { /* the peer may already be gone */ }
  }

  function writeToConnection(connection, payload) {
    if (connection.closed) return;
    try {
      connection.response.write(payload);
    } catch (_) {
      closeConnection(connection);
    }
  }

  function sendEvent(event, data) {
    const payload = eventText(event, data);
    for (const connection of [...connections]) writeToConnection(connection, payload);
  }

  const server = createServer((request, response) => {
    if (!isAuthorized(request, secret)) {
      jsonResponse(response, 401, { error: 'unauthorized' });
      return;
    }

    const pathname = String(request.url || '/').split('?', 1)[0];
    if (request.method === 'GET' && pathname === '/api/stats') {
      jsonResponse(response, 200, currentStats);
      return;
    }

    if (request.method === 'GET' && pathname === '/api/stats/stream') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      const connection = { response, timer: null, closed: false };
      connections.add(connection);
      const cleanup = () => removeConnection(connection);
      response.once('close', cleanup);
      response.once('error', cleanup);
      request.once('aborted', cleanup);
      if (Number.isFinite(heartbeatInterval) && heartbeatInterval > 0) {
        connection.timer = setInterval(() => writeToConnection(connection, ': heartbeat\n\n'), heartbeatInterval);
        connection.timer.unref?.();
      }
      writeToConnection(connection, eventText('snapshot', {
        type: 'stats',
        reason: 'snapshot',
        stats: currentStats,
        at: new Date().toISOString()
      }));
      return;
    }

    jsonResponse(response, 404, { error: 'not_found' });
  });

  server.listen(port, '127.0.0.1');

  function publish(statsNext) {
    currentStats = statsNext;
    sendEvent('stats', {
      type: 'stats',
      reason: 'update',
      stats: currentStats,
      at: new Date().toISOString()
    });
    return currentStats;
  }

  function sendRaw(data, event = 'stats') {
    sendEvent(event, data);
  }

  function disconnect() {
    for (const connection of [...connections]) closeConnection(connection);
  }

  let closePromise;
  function close() {
    if (closePromise) return closePromise;
    disconnect();
    closePromise = new Promise((resolve) => {
      if (!server.listening) {
        // The listen callback is asynchronous. If close is called immediately
        // after construction, close the server as soon as it becomes ready.
        if (server.address() === null) {
          server.once('listening', () => server.close(() => resolve()));
          server.once('error', () => resolve());
          return;
        }
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    return closePromise;
  }

  return {
    server,
    publish,
    sendRaw,
    disconnect,
    close,
    get url() {
      const address = server.address();
      return address && typeof address === 'object'
        ? `http://127.0.0.1:${address.port}`
        : 'http://127.0.0.1:0';
    },
    get connections() {
      return connections.size;
    }
  };
}

async function runCli() {
  const configuredPortText = process.env.MOCK_PORT;
  const configuredPort = configuredPortText === undefined
    ? 17321
    : Number(configuredPortText.trim());
  if (
    configuredPortText !== undefined
    && (!/^\d+$/u.test(configuredPortText.trim())
      || !Number.isSafeInteger(configuredPort)
      || configuredPort < 0
      || configuredPort > 65535)
  ) {
    throw new Error('MOCK_PORT must be an integer between 0 and 65535');
  }
  const port = configuredPort;
  const secret = String(process.env.MOCK_SECRET || 'mock-secret');
  const hub = createMockHub({ port, secret });
  await new Promise((resolve, reject) => {
    if (hub.server.listening) {
      resolve();
      return;
    }
    hub.server.once('listening', resolve);
    hub.server.once('error', reject);
  });
  console.log(`Mock Hub listening on ${hub.url}`);

  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    hub.publish(makeStats({
      costUsd: 12.5 + tick,
      usedPercent: (25 + tick) % 101,
      at: new Date().toISOString()
    }));
  }, 5000);
  timer.unref?.();

  const stop = async () => {
    clearInterval(timer);
    await hub.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (isDirectCliInvocation()) runCli().catch((error) => {
  console.error(`Mock Hub failed to start: ${error.message}`);
  process.exitCode = 1;
});
