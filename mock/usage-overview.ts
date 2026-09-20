import type { UsageOverview } from '../contracts/usage-overview.ts';

export const mockUsageOverview = {
  hubs: [
    {
      hubId: 'tokyo',
      name: 'Tokyo Hub',
      state: {
        updatedAt: '2026-09-20T11:36:14.718Z',
        receivedAt: '2026-09-20T11:36:15.012Z',
        devices: [
          { deviceId: 'tokyo-mac', hostname: 'mac-studio', platform: 'darwin', updatedAt: '2026-09-20T11:36:14.718Z', stale: false },
          { deviceId: 'tokyo-win', hostname: 'win-pro', platform: 'win32', updatedAt: '2026-09-20T11:35:52.004Z', stale: false },
        ],
      },
    },
    {
      hubId: 'osaka',
      name: 'Osaka Hub',
      state: {
        updatedAt: '2026-09-20T11:36:15.238Z',
        receivedAt: '2026-09-20T11:36:15.401Z',
        devices: [
          { deviceId: 'osaka-linux', hostname: 'linux-main', platform: 'linux', updatedAt: '2026-09-20T11:36:15.238Z', stale: false },
          { deviceId: 'osaka-cloud', hostname: 'cloud-runner', platform: 'linux', updatedAt: '2026-09-20T11:35:41.238Z', stale: false },
          { deviceId: 'osaka-win', hostname: 'win-lab', platform: 'win32', updatedAt: '2026-09-20T11:34:58.238Z', stale: false },
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
