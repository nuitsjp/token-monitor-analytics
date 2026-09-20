import type { UsageOverview } from '../../../contracts/usage-overview.ts';
import { rpc } from './client.ts';

export async function getUsageOverview(): Promise<UsageOverview> {
  if (__MOCK__) {
    const { mockUsageOverview } = await import('../../../mock/usage-overview.ts');
    return mockUsageOverview;
  }
  return rpc.usageOverview.query();
}
