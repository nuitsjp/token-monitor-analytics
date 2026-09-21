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

export async function subscribeUsageUpdates(
  onUpdate: (overview: UsageOverview) => void,
  onStatus: (status: UsageConnectionStatus) => void,
): Promise<() => void> {
  if (__MOCK__) {
    const { mockUsageUpdates } = await import('../../../mock/usage-overview.ts');
    const timers = mockUsageUpdates.map((frame) => window.setTimeout(() => {
      if (frame.overview) onUpdate(frame.overview);
      onStatus(frame.status);
    }, frame.afterMs));
    return () => timers.forEach(window.clearTimeout);
  }
  // UC-2-X1 段階2: 実SSEへの接続はモックの動作合意後に行う。
  return () => {};
}
