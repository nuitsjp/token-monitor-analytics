import type { UsageOverview } from '../contracts/usage-overview.ts';

export const mockUsageOverview = {
  hubs: [
    {
      hubId: 'tokyo',
      name: 'Tokyo Hub',
      usage: {
        todayTokens: 42_930_120,
        todayCostUsd: 31.19,
        deviceCount: 2,
        updatedAt: '2026-09-20T11:36:14.718Z',
      },
    },
    {
      hubId: 'osaka',
      name: 'Osaka Hub',
      usage: {
        todayTokens: 8_420_500,
        todayCostUsd: 4.82,
        deviceCount: 5,
        updatedAt: '2026-09-20T11:36:15.238Z',
      },
    },
    {
      hubId: 'sapporo',
      name: 'Sapporo Hub',
      usage: null,
    },
  ],
} satisfies UsageOverview;
