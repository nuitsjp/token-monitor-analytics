import {randomBytes} from 'node:crypto';
import {streamHub, isPermanent, HTTPError} from './sse.mjs';

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

export function jitter(ms, random = Math.random) {
  return Math.min(BACKOFF_MAX_MS, ms + Math.floor(random() * 500));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

function errorCode(error) {
  if (error?.code === 'input_error') return 'input_error';
  if (error?.code === 'config_error') return 'config_error';
  if (error?.code === 'storage_error') return 'storage_error';
  if (error instanceof HTTPError && (error.status === 401 || error.status === 403)) return 'auth_error';
  return 'permanent_error';
}

/**
 * Run one Hub subscription. Event callbacks are awaited before reading the
 * next frame, so a slow SQLite commit applies backpressure to that Hub only.
 */
export async function subscribeLoop({
  hub,
  onObservation = async () => {},
  onStatus,
  onFatal,
  idleMs = 90_000,
  headerTimeoutMs,
  fetchImpl,
  signal,
  isCurrent = () => true,
  jitterFn = jitter,
} = {}) {
  let backoff = BACKOFF_MIN_MS;
  const emit = (state, errorCode = '') => {
    if (isCurrent()) onStatus?.({hubId: hub.id, state, errorCode});
  };

  while (!signal?.aborted && isCurrent()) {
    emit('connecting');
    const streamId = randomBytes(16).toString('hex');
    let delivered = false;
    let failure = null;
    try {
      await streamHub({
        url: hub.url,
        secret: hub.secret,
        idleMs,
        headerTimeoutMs,
        signal,
        fetchImpl,
        onConnected: () => emit('connected'),
        onEvent: async (event) => {
          if (!isCurrent() || signal?.aborted) return;
          if (event.name !== 'snapshot' && event.name !== 'stats') return;
          await onObservation({hubId: hub.id, name: event.name, data: event.data, streamId});
          if (isCurrent() && !signal?.aborted) delivered = true;
        },
      });
    } catch (error) {
      failure = error;
    }

    if (signal?.aborted || !isCurrent()) return;
    if (failure?.code === 'storage_error' || failure?.fatal === true) {
      emit('error', 'storage_error');
      onFatal?.(failure);
      return;
    }
    if (failure && isPermanent(failure)) {
      emit('error', errorCode(failure));
      return;
    }

    emit('error', 'network_error');
    if (delivered) backoff = BACKOFF_MIN_MS;
    try {
      await sleep(jitterFn(backoff), signal);
    } catch {
      return;
    }
    if (!isCurrent()) return;
    if (backoff < BACKOFF_MAX_MS) backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}
