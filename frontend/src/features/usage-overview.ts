import type { UsageOverview } from '../../../contracts/usage-overview.ts';
import { rpc } from './client.ts';

export type UsageConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export const usageOverviewQuery = {
  queryKey: ['usage-overview'],
  queryFn: getUsageOverview,
  staleTime: Infinity,
};

export async function getUsageOverview(): Promise<UsageOverview> {
  if (__MOCK__) {
    const { mockUsageOverview } = await import('../../../mock/usage-overview.ts');
    return mockUsageOverview;
  }
  return rpc.usageOverview.query();
}

export function subscribeUsageUpdates(
  onUpdate: (overview: UsageOverview) => void,
  onStatus: (status: UsageConnectionStatus) => void,
): () => void {
  if (__MOCK__) {
    onStatus('connected');
    return () => {};
  }
  let disposed = false;
  let source: EventSource | null = null;
  let retryTimer: number | null = null;

  const clearRetryTimer = () => {
    if (retryTimer === null) return;
    window.clearTimeout(retryTimer);
    retryTimer = null;
  };

  const closeSource = () => {
    const current = source;
    source = null;
    current?.close();
  };

  const connect = () => {
    if (disposed || source !== null) return;
    const current = new EventSource('/api/usage/stream');
    source = current;
    current.addEventListener('update', (event) => {
      if (disposed || source !== current) return;
      const overview = JSON.parse((event as MessageEvent<string>).data) as UsageOverview;
      onUpdate(overview);
      if (disposed || source !== current) return;
      onStatus('connected');
    });
    current.onerror = () => {
      if (disposed || source !== current) return;
      onStatus('reconnecting');
      if (disposed || source !== current) return;
      closeSource();
      if (!disposed && retryTimer === null) {
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          connect();
        }, 3000);
      }
    };
  };

  onStatus('connecting');
  connect();

  return () => {
    if (disposed) return;
    disposed = true;
    clearRetryTimer();
    closeSource();
  };
}
