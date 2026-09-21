import type { UsageOverview } from '../contracts/usage-overview.ts';

export const mockUsageOverview = {
  hubs: [
    {
      hubId: 'tokyo',
      name: 'Tokyo Hub',
      state: {
        updatedAt: '2026-09-21T11:36:14.718Z',
        receivedAt: '2026-09-21T11:36:15.012Z',
        activeDays: 15,
        periods: {
          today: { totalTokens: 42621015, costUsd: 29.89 },
          month: { totalTokens: 3862063575, costUsd: 1561.13 },
          total: { totalTokens: 24419264000, costUsd: 9869.05 },
        },
        devices: [
          { deviceId: 'tokyo-mac', hostname: 'mac-studio', platform: 'darwin', updatedAt: '2026-09-21T11:36:14.718Z', stale: false },
          { deviceId: 'tokyo-win', hostname: 'win-pro', platform: 'win32', updatedAt: '2026-09-21T11:35:52.004Z', stale: false },
        ],
      },
    },
    {
      hubId: 'osaka',
      name: 'Osaka Hub',
      state: {
        updatedAt: '2026-09-21T11:36:15.238Z',
        receivedAt: '2026-09-21T11:36:15.401Z',
        activeDays: 28,
        periods: {
          today: { totalTokens: 8729605, costUsd: 6.12 },
          month: { totalTokens: 791025069, costUsd: 319.75 },
          total: { totalTokens: 5001536000, costUsd: 2021.37 },
        },
        devices: [
          { deviceId: 'osaka-linux', hostname: 'linux-main', platform: 'linux', updatedAt: '2026-09-21T11:36:15.238Z', stale: false },
          { deviceId: 'osaka-cloud', hostname: 'cloud-runner', platform: 'linux', updatedAt: '2026-09-21T11:35:41.238Z', stale: false },
          { deviceId: 'osaka-win', hostname: 'win-lab', platform: 'win32', updatedAt: '2026-09-21T11:34:58.238Z', stale: false },
        ],
      },
    },
    {
      hubId: 'sapporo',
      name: 'Sapporo Hub',
      state: null,
    },
  ],
} satisfies UsageOverview;
