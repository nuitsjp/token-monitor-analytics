export function createUpdateRestartController({
  fetchHealth,
  fetchStatus,
  intervalMs = 2000,
  timeoutMs = 180000,
  now = () => Date.now(),
  onProgress = () => {},
  onSuccess = () => {},
  onFailure = () => {},
  onTimeout = () => {}
} = {}) {
  let active = false;
  let timer = null;
  let generation = 0;

  const stop = () => {
    active = false;
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const start = (jobId, targetCommitSha) => {
    if (active || typeof jobId !== 'string' || typeof targetCommitSha !== 'string') return false;
    active = true;
    const currentGeneration = ++generation;
    const deadline = now() + timeoutMs;

    const poll = async () => {
      if (!active || generation !== currentGeneration) return;
      let health = null;
      let status = null;
      try { health = await fetchHealth(); } catch {}
      try {
        const response = await fetchStatus();
        const body = await response.json();
        status = {response, body};
      } catch {}

      if (!active || generation !== currentGeneration) return;
      const job = status?.body?.job;
      const current = status?.body?.current ?? {};
      if (job?.jobId === jobId) {
        onProgress(job);
        if (job.status === 'failed' || job.status === 'aborted') {
          stop();
          await onFailure(job);
          return;
        }
        if (health?.ok && status?.response?.ok && job.status === 'completed' && job.stage === 'success'
          && (current.commitSha === targetCommitSha || job.outcome === 'unchanged')) {
          stop();
          await onSuccess({job, current, unchanged: job.outcome === 'unchanged'});
          return;
        }
      }
      if (now() >= deadline) {
        stop();
        await onTimeout({jobId, targetCommitSha});
        return;
      }
      timer = setTimeout(() => { void poll(); }, intervalMs);
      timer.unref?.();
    };
    void poll();
    return true;
  };

  return {start, stop, isActive: () => active};
}
