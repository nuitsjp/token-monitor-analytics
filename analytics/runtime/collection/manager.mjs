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
  // Optional lifecycle hooks are used by the history scheduler. They share
  // this manager's generation fence and shutdown wait.
  onConnected,
  onRevision,
  onStopped,
  idleMs = 90_000,
  headerTimeoutMs,
  fetchImpl,
  jitterFn,
} = {}) {
  const runners = new Map();
  // Runners removed by the synchronous generation fence remain here until
  // their stream and any awaited observation callback have finished.  This
  // prevents replacement and shutdown from overtaking old work.
  const retiring = new Set();
  let stopped = false;
  let stopPromise = null;
  let applyTail = Promise.resolve();
  // Every desired-state submission gets a token.  A queued reconciliation may
  // be waiting for an old runner; a later commit must prevent that stale
  // reconciliation from starting its old settings when the wait completes.
  let desiredGeneration = 0;
  let nextRunnerGeneration = 0;

  const publish = (runner, state, errorCode = '') => {
    runner.state = state;
    runner.errorCode = errorCode;
    runner.updatedAt = new Date().toISOString();
    onStatus?.({hubId: runner.hub.id, state, errorCode, updatedAt: runner.updatedAt});
  };

  const stopRunner = (id) => {
    const runner = runners.get(id);
    if (!runner) return Promise.resolve();
    invalidateHub(id, {fence: false});
    return runner.completion || runner.done || Promise.resolve();
  };

  /**
   * Invalidate a Hub synchronously.  Management calls this directly after its
   * SQLite COMMIT, before awaiting any stream shutdown or reconciliation.
   * Removing the runner first makes callbacks that are already queued observe
   * a stale generation and skip their write.
   */
  function invalidateHub(id, {fence = true} = {}) {
    if (fence) desiredGeneration++;
    const runner = runners.get(id);
    if (!runner) return false;
    runners.delete(id);
    runner.invalidated = true;
    retiring.add(runner);
    try {
      const stoppedHook = onStopped?.({hub: runner.hub, generation: runner.generation});
      runner.stopHook = stoppedHook && typeof stoppedHook.then === 'function'
        ? stoppedHook
        : Promise.resolve();
    } catch (error) {
      runner.stopHook = Promise.reject(error);
      runner.stopHook.catch(() => {});
    }
    runner.controller.abort();
    runner.completion = Promise.all([runner.done || Promise.resolve(), runner.stopHook || Promise.resolve()]);
    runner.completion.finally(() => retiring.delete(runner)).catch(() => {});
    return true;
  }

  const waitForRetiring = async () => {
    do {
      await Promise.all([...retiring].map(runner => runner.completion || runner.done || Promise.resolve()));
    } while (retiring.size);
  };

  const startRunner = (hub) => {
    const controller = new AbortController();
    const runner = {
      hub: {id: hub.id, url: hub.url, secret: hub.secret},
      controller,
      done: null,
      completion: null,
      stopHook: null,
      generation: ++nextRunnerGeneration,
      invalidated: false,
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
      onConnected: (event) => {
        if (runners.get(hub.id) === runner) onConnected?.({hub: runner.hub, generation: runner.generation, ...event});
      },
      onRevision: (event) => {
        if (runners.get(hub.id) === runner) onRevision?.({hub: runner.hub, generation: runner.generation, ...event});
      },
      onObservation: async (observation) => {
        if (runners.get(hub.id) !== runner || runner.invalidated) return;
        await onObservation?.(observation, {
          hubId: hub.id,
          generation: runner.generation,
          isCurrent: () => runners.get(hub.id) === runner && !runner.invalidated,
        });
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

  async function applyHubsNow(hubs, generation) {
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
    await Promise.all([...stopping, waitForRetiring()]);
    // A management commit can fence this operation while it is waiting for
    // the retired stream.  Never start the superseded URL/secret generation.
    if (stopped || generation !== desiredGeneration) return;
    for (const [id, hub] of active) if (!runners.has(id)) startRunner(hub);
  }

  function enqueue(operation) {
    const next = applyTail.then(operation);
    applyTail = next.catch(() => {});
    return next;
  }

  function applyHubs(hubs) {
    const generation = ++desiredGeneration;
    return enqueue(() => applyHubsNow(hubs, generation));
  }

  async function start(hubs = []) {
    if (stopped) throw new Error('collection manager is stopped');
    return applyHubs(hubs);
  }

  async function reconnectHub(id) {
    const generation = ++desiredGeneration;
    return enqueue(async () => {
      const runner = runners.get(id);
      if (!runner || stopped) return false;
      const hub = {...runner.hub, status: 'active'};
      await stopRunner(id);
      await waitForRetiring();
      if (!stopped && generation === desiredGeneration) startRunner(hub);
      return true;
    });
  }

  async function stopHub(id) {
    // A direct stop is also a desired-state change.  Fence a reconciliation
    // that may still be waiting for this Hub's retiring stream.
    desiredGeneration++;
    return enqueue(async () => {
      if (!runners.has(id)) return false;
      await stopRunner(id);
      await waitForRetiring();
      return true;
    });
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    desiredGeneration++;
    stopPromise = enqueue(async () => {
      const stopping = [...runners.keys()].map(stopRunner);
      await Promise.all([...stopping, waitForRetiring()]);
    });
    return stopPromise;
  }

  function getStatus() {
    return [...runners.values()].map(r => ({hubId: r.hub.id, state: r.state, errorCode: r.errorCode, updatedAt: r.updatedAt}));
  }

  return {start, applyHubs, invalidateHub, stopHub, reconnectHub, reconnect: reconnectHub, stop, getStatus};
}
