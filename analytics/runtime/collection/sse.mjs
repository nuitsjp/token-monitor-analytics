import {validateHubUrl} from '../../src/hubs.ts';

export const MAX_EVENT_BYTES = 8 << 20;
export const DEFAULT_IDLE_MS = 90_000;
export const DEFAULT_HEADER_TIMEOUT_MS = 20_000;

export class HTTPError extends Error {
  constructor(status) {
    super(`Hub HTTP ${status}`);
    this.name = 'HTTPError';
    this.status = status;
  }
}

export class CollectionConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CollectionConfigError';
    this.code = 'config_error';
    this.permanent = true;
  }
}

export class IdleTimeoutError extends Error {
  constructor() {
    super('SSE idle timeout');
    this.name = 'IdleTimeoutError';
    this.code = 'idle_timeout';
  }
}

export class HeaderTimeoutError extends Error {
  constructor() {
    super('SSE connection/header timeout');
    this.name = 'HeaderTimeoutError';
    this.code = 'network_error';
  }
}

export class SSEInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SSEInputError';
    this.code = 'input_error';
    this.permanent = true;
  }
}

/** Permanent: 3xx, or 4xx except 408/429, plus validated input/config errors. */
export function isPermanent(error) {
  return Boolean(error?.permanent) || error instanceof HTTPError &&
    ((error.status >= 300 && error.status < 400) ||
      (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429));
}

function pullLines(text, atEnd) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10) {
      lines.push(text.slice(start, i));
      start = i + 1;
      continue;
    }
    if (code !== 13) continue;
    if (i + 1 === text.length && !atEnd) break;
    lines.push(text.slice(start, i));
    if (text.charCodeAt(i + 1) === 10) i++;
    start = i + 1;
  }
  return {lines, rest: text.slice(start)};
}

async function readWithIdle(reader, idleMs, signal, onIdle) {
  const read = reader.read();
  let timeout;
  let abort;
  let onAbort;
  const idle = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      onIdle?.();
      reject(new IdleTimeoutError());
    }, idleMs);
    timeout.unref?.();
  });
  if (signal) {
    abort = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason || new Error('aborted'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, {once: true});
    });
  }
  try {
    return await Promise.race(abort ? [read, idle, abort] : [read, idle]);
  } finally {
    clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Read an SSE body without buffering more than one event. UTF-8 decoding is
 * streaming, so a multibyte code point split across HTTP chunks is preserved.
 * A frame without a terminating blank line is intentionally discarded at EOF.
 */
export async function readSSE(stream, onEvent, {onActivity, idleMs = 0, signal} = {}) {
  if (!stream) throw new Error('missing SSE body');
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const encoder = new TextEncoder();
  let pending = '';
  let name = '';
  let data = '';
  let dataBytes = 0;
  let first = true;

  const handleLine = async (line) => {
    if (encoder.encode(line).byteLength > MAX_EVENT_BYTES) throw new SSEInputError(`SSE event exceeds ${MAX_EVENT_BYTES} bytes`);
    if (first) {
      line = line.replace(/^\uFEFF/, '');
      first = false;
    }
    if (line === '') {
      if (data.length > 0) {
        const event = {name: name || 'message', data: data.slice(0, -1)};
        name = '';
        data = '';
        dataBytes = 0;
        await onEvent(event);
      } else {
        name = '';
        data = '';
        dataBytes = 0;
      }
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      name = value;
    } else if (field === 'data') {
      dataBytes += encoder.encode(value).byteLength + 1;
      if (dataBytes > MAX_EVENT_BYTES) throw new SSEInputError(`SSE event exceeds ${MAX_EVENT_BYTES} bytes`);
      data += value + '\n';
    }
    // id/retry are deliberately ignored: the Hub has no replay contract.
  };

  try {
    while (true) {
      const result = idleMs > 0
        ? await readWithIdle(reader, idleMs, signal, () => {})
        : await (signal ? readWithIdle(reader, 2 ** 31 - 1, signal, () => {}) : reader.read());
      if (result.done) {
      try { pending += decoder.decode(); }
      catch { throw new SSEInputError('invalid UTF-8 in SSE stream'); }
        const {lines} = pullLines(pending, true);
        for (const line of lines) await handleLine(line);
        if (encoder.encode(pending.slice(pending.lastIndexOf('\n') + 1)).byteLength > MAX_EVENT_BYTES) throw new SSEInputError(`SSE event exceeds ${MAX_EVENT_BYTES} bytes`);
        // Do not handle the remaining partial line: incomplete EOF is dropped.
        return;
      }
      if (result.value && result.value.byteLength > 0) onActivity?.();
      try { pending += decoder.decode(result.value, {stream: true}); }
      catch { throw new SSEInputError('invalid UTF-8 in SSE stream'); }
      const pulled = pullLines(pending, false);
      pending = pulled.rest;
      if (encoder.encode(pending).byteLength > MAX_EVENT_BYTES) throw new SSEInputError(`SSE event exceeds ${MAX_EVENT_BYTES} bytes`);
      for (const line of pulled.lines) await handleLine(line);
    }
  } catch (error) {
    try { await reader.cancel(error); } catch {}
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function mediaType(contentType) {
  return typeof contentType === 'string' ? contentType.split(';', 1)[0].trim().toLowerCase() : '';
}

function linkSignal(signal) {
  const controller = new AbortController();
  if (!signal) return {signal: controller.signal, controller, detach() {}};
  if (signal.aborted) controller.abort(signal.reason);
  const onAbort = () => controller.abort(signal.reason);
  if (!signal.aborted) signal.addEventListener('abort', onAbort, {once: true});
  return {signal: controller.signal, controller, detach: () => signal.removeEventListener('abort', onAbort)};
}

/** Open one authenticated Hub SSE request. Redirects are never followed. */
export async function streamHub({
  url,
  secret,
  idleMs = DEFAULT_IDLE_MS,
  headerTimeoutMs = DEFAULT_HEADER_TIMEOUT_MS,
  signal,
  fetchImpl = globalThis.fetch,
  onConnected,
  onEvent = async () => {},
  onActivity,
  onByte,
} = {}) {
  let origin;
  try { origin = validateHubUrl(url); } catch { throw new CollectionConfigError('invalid Hub URL'); }
  if (typeof secret !== 'string' || !secret || /[\r\n\0]/.test(secret)) {
    throw new CollectionConfigError('missing or invalid shared secret');
  }
  const linked = linkSignal(signal);
  const timeoutMs = Number.isFinite(headerTimeoutMs) && headerTimeoutMs > 0 ? headerTimeoutMs : DEFAULT_HEADER_TIMEOUT_MS;
  let headerTimedOut = false;
  const headerTimer = setTimeout(() => {
    headerTimedOut = true;
    linked.controller.abort(new HeaderTimeoutError());
  }, timeoutMs);
  headerTimer.unref?.();

  try {
    let response;
    try {
      response = await fetchImpl(`${origin}/api/stats/stream`, {
        method: 'GET',
        headers: {Authorization: `Bearer ${secret}`, Accept: 'text/event-stream', 'Cache-Control': 'no-cache'},
        redirect: 'manual',
        signal: linked.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (headerTimedOut) throw new HeaderTimeoutError();
      throw Object.assign(new Error('SSE connection failed'), {code: 'network_error'});
    } finally {
      clearTimeout(headerTimer);
    }
    if (headerTimedOut) throw new HeaderTimeoutError();
    if (signal?.aborted) return;
    if (response.status !== 200) throw new HTTPError(response.status);
    if (mediaType(response.headers?.get?.('content-type')) !== 'text/event-stream') {
      throw Object.assign(new Error('expected text/event-stream'), {code: 'network_error'});
    }
    if (!response.body) throw Object.assign(new Error('missing SSE body'), {code: 'network_error'});
    onConnected?.();
    await readSSE(response.body, onEvent, {
      signal: linked.signal,
      idleMs: idleMs > 0 ? idleMs : DEFAULT_IDLE_MS,
      onActivity: () => { onActivity?.(); onByte?.(); },
    });
  } finally {
    clearTimeout(headerTimer);
    // Abort also releases a pending body read and closes the HTTP connection
    // after a callback, malformed frame, or normal runner replacement.
    linked.controller.abort();
    linked.detach();
  }
}
