import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { createStore } from './store.js';
import { parseSnapshot } from './snapshot.js';
import { connectHub } from './hub-stream.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);

export function createAnalytics(config, { store = createStore(config.databasePath), logger = console, reconnectMs = 3000 } = {}) {
  try { store.registerHub(config.hub); } catch (error) { store.close(); throw error; }
  const credentials = Buffer.from(`${config.username}:${config.password}`, 'utf8');
  const secrets = [config.hub.secret, config.password, credentials.toString('base64')];
  const redact = value => secrets.reduce((text, secret) => secret ? text.replaceAll(secret, '[redacted]') : text, String(value));
  const hub = {
    id: config.hub.id, name: config.hub.name,
    connection: 'disconnected', connectionError: null, validationError: null, storageError: null,
    snapshot: store.readSnapshot(config.hub.id)
  };
  let queue = Promise.resolve();
  let stream;
  let closing = false;
  const clients = new Set();
  const view = () => ({ estimation: 'notImplemented', hubs: [hub] });
  function log(operation, message) {
    logger.error(JSON.stringify({ at: new Date().toISOString(), hub: hub.id, operation, error: redact(message) }));
  }
  function notify(event) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(view())}\n\n`;
    for (const response of clients) response.write(frame);
  }
  function accept(data, receivedAt) {
    queue = queue.then(() => {
      if (hub.storageError) return;
      let parsed;
      try { parsed = parseSnapshot(data); } catch (error) {
        hub.validationError = redact(error.message);
        log('validate', hub.validationError);
        notify('status');
        return;
      }
      try {
        hub.snapshot = store.saveSnapshot(hub.id, parsed, receivedAt);
      } catch (error) {
        hub.storageError = `保存失敗: ${redact(error.message)}。書き込みを停止しました。原因を解消して再起動してください。`;
        log('save', hub.storageError);
        notify('status');
        return;
      }
      hub.validationError = null;
      notify('update');
    });
  }
  function authorized(header) {
    if (typeof header !== 'string' || !/^Basic /i.test(header)) return false;
    const received = Buffer.from(header.slice(6), 'base64');
    return received.length === credentials.length && timingSafeEqual(received, credentials);
  }
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (!authorized(request.headers.authorization)) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Token Monitor Analytics", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('認証が必要です。');
      return;
    }
    if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }); response.end(); return; }
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/api/current') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(view()));
    } else if (pathname === '/api/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      response.write(`event: status\ndata: ${JSON.stringify(view())}\n\n`);
      clients.add(response);
      response.on('error', () => clients.delete(response));
      response.on('close', () => clients.delete(response));
    } else if (assets.has(pathname)) {
      const [file, contentType] = assets.get(pathname);
      response.writeHead(200, { 'Content-Type': contentType });
      response.end(readFileSync(new URL(`../public/${file}`, import.meta.url)));
    } else { response.writeHead(404); response.end(); }
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': heartbeat\n\n');
  }, 30000);
  heartbeat.unref();
  return {
    server, store,
    current: view,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
      });
      stream = connectHub(config.hub, { reconnectMs, onEvent: accept, onConnection(connected, error) {
        hub.connection = connected ? 'connected' : 'disconnected';
        hub.connectionError = error ? redact(error) : null;
        if (error) log('connect', error);
        notify('status');
      } });
    },
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(heartbeat);
      await stream?.stop();
      await queue;
      for (const client of clients) client.end();
      await new Promise((resolve, reject) => {
        server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
        server.closeAllConnections();
      });
      store.close();
    }
  };
}
