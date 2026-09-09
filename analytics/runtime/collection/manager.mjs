import {subscribeLoop} from './subscribe.mjs';

/**
 * Owns one abort controller and one completion promise per active Hub. Hub
 * settings are copied into a runner so later settings changes cannot mutate a
 * live request. Secrets are never included in status snapshots.
 */
export function createCollectionManager({
  onObservation,
  onStatus,
  onFatal,
  idleMs = 90_000,
  headerTimeoutMs,
  fetchImpl,
  jitterFn,
} = {}) {
  const runners = new Map();
  let stopped = false;
  let stopPromise = null;
  let applyTail = Promise.resolve();

  const publish = (runner, state, errorCode = '') => {
    runner.state = state;
    runner.errorCode = errorCode;
    runner.updatedAt = new Date().toISOString();
    onStatus?.({hubId: runner.hub.id, state, errorCode, updatedAt: runner.updatedAt});
  };

  const stopRunner = (id) => {
    const runner = runners.get(id);
    if (!runner) return Promise.resolve();
    // Removing it first is the generation fence for callbacks already in flight.
    runners.delete(id);
    runner.controller.abort();
    return runner.done || Promise.resolve();
  };

  const startRunner = (hub) => {
    const controller = new AbortController();
    const runner = {
      hub: {id: hub.id, url: hub.url, secret: hub.secret},
      controller,
      done: null,
      state: 'connecting',
      errorCode: '',
      updatedAt: new Date().toISOString(),
    };
    runners.set(hub.id, runner);
    publish(runner, 'connecting');
    runner.done = subscribeLoop({
      hub: runner.hub,
      idleMs,
      headerTimeoutMs,
      fetchImpl,
      jitterFn,
      signal: controller.signal,
      isCurrent: () => runners.get(hub.id) === runner,
      onObservation: async (observation) => {
        if (runners.get(hub.id) !== runner) return;
        await onObservation?.(observation);
      },
      onStatus: (status) => {
        if (runners.get(hub.id) === runner) publish(runner, status.state, status.errorCode || '');
      },
      onFatal: (error) => {
        if (runners.get(hub.id) === runner) onFatal?.(error, hub.id);
      },
    }).catch((error) => {
      // A runner is isolated; its public state is emitted before it exits.
      if (runners.get(hub.id) === runner) publish(runner, 'error', error?.code || 'network_error');
    });
  };

  async function applyHubsNow(hubs) {
    if (stopped) return;
    const active = new Map();
    for (const hub of Array.isArray(hubs) ? hubs : []) {
      if (!hub || typeof hub.id !== 'string' || hub.status !== 'active') continue;
      active.set(hub.id, hub);
    }

    const stopping = [];
    for (const [id, runner] of runners) {
      const next = active.get(id);
      if (!next || next.url !== runner.hub.url || next.secret !== runner.hub.secret) stopping.push(stopRunner(id));
    }
    // Do not start a replacement until the previous generation's stream and
    // awaited observation callback have finished.
    await Promise.all(stopping);
    if (stopped) return;
    for (const [id, hub] of active) if (!runners.has(id)) startRunner(hub);
  }

  function enqueue(operation) {
    const next = applyTail.then(operation);
    applyTail = next.catch(() => {});
    return next;
  }

  function applyHubs(hubs) {
    return enqueue(() => applyHubsNow(hubs));
  }

  async function start(hubs = []) {
    if (stopped) throw new Error('collection manager is stopped');
    return applyHubs(hubs);
  }

  async function reconnectHub(id) {
    return enqueue(async () => {
      const runner = runners.get(id);
      if (!runner || stopped) return false;
      const hub = {...runner.hub, status: 'active'};
      await stopRunner(id);
      if (!stopped) startRunner(hub);
      return true;
    });
  }

  async function stopHub(id) {
    return enqueue(async () => {
      if (!runners.has(id)) return false;
      await stopRunner(id);
      return true;
    });
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    stopPromise = enqueue(() => Promise.all([...runners.keys()].map(stopRunner)));
    return stopPromise;
  }

  function getStatus() {
    return [...runners.values()].map(r => ({hubId: r.hub.id, state: r.state, errorCode: r.errorCode, updatedAt: r.updatedAt}));
  }

  return {start, applyHubs, stopHub, reconnectHub, reconnect: reconnectHub, stop, getStatus};
}
