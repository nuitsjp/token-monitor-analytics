import type { UsageOverview } from '../contracts/usage-overview.ts';

export const mockUsageOverview = {
  hubs: [
    {
      hubId: 'tokyo',
      name: 'Tokyo Hub',
      state: {
        updatedAt: '2026-09-20T11:36:14.718Z',
        receivedAt: '2026-09-20T11:36:15.012Z',
        periods: {
          today: { totalTokens: 42621015, costUsd: 29.89 },
          month: { totalTokens: 3862063575, costUsd: 1561.13 },
          total: { totalTokens: 24419264000, costUsd: 9869.05 },
        },
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
        periods: {
          today: { totalTokens: 8729605, costUsd: 6.12 },
          month: { totalTokens: 791025069, costUsd: 319.75 },
          total: { totalTokens: 5001536000, costUsd: 2021.37 },
        },
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

const receivedSapporoState = {
  updatedAt: '2026-09-20T11:36:22.501Z',
  receivedAt: '2026-09-20T11:36:22.664Z',
  periods: {
    today: { totalTokens: 1204000, costUsd: 0.84 },
    month: { totalTokens: 8420000, costUsd: 5.89 },
    total: { totalTokens: 84200000, costUsd: 58.94 },
  },
  devices: [
    { deviceId: 'sapporo-mini', hostname: 'mini-pc', platform: 'linux', updatedAt: '2026-09-20T11:36:22.501Z', stale: false },
  ],
};

export const mockUsageUpdates = [
  {
    afterMs: 0,
    overview: mockUsageOverview,
    status: 'connected',
  },
  {
    afterMs: 5000,
    overview: {
      hubs: [
        {
          ...mockUsageOverview.hubs[0],
          state: {
            updatedAt: '2026-09-20T11:36:20.718Z',
            receivedAt: '2026-09-20T11:36:21.012Z',
            periods: {
              today: { totalTokens: 45121015, costUsd: 31.62 },
              month: { totalTokens: 3916203575, costUsd: 1582.84 },
              total: { totalTokens: 24519264000, costUsd: 9905.47 },
            },
            devices: [
              { deviceId: 'tokyo-mac', hostname: 'mac-studio', platform: 'darwin', updatedAt: '2026-09-20T11:36:20.718Z', stale: false },
              { deviceId: 'tokyo-win', hostname: 'win-pro', platform: 'win32', updatedAt: '2026-09-20T11:36:18.004Z', stale: false },
            ],
          },
        },
        mockUsageOverview.hubs[1],
        {
          ...mockUsageOverview.hubs[2],
          state: receivedSapporoState,
        },
      ],
    },
    status: 'connected',
  },
  {
    afterMs: 10000,
    status: 'reconnecting',
  },
  {
    afterMs: 15000,
    overview: {
      hubs: [
        {
          ...mockUsageOverview.hubs[0],
          state: {
            updatedAt: '2026-09-20T11:36:30.718Z',
            receivedAt: '2026-09-20T11:36:31.012Z',
            periods: {
              today: { totalTokens: 52621015, costUsd: 36.91 },
              month: { totalTokens: 4066203575, costUsd: 1641.88 },
              total: { totalTokens: 24919264000, costUsd: 10068.31 },
            },
            devices: [
              { deviceId: 'tokyo-mac', hostname: 'mac-studio', platform: 'darwin', updatedAt: '2026-09-20T11:36:30.718Z', stale: false },
              { deviceId: 'tokyo-win', hostname: 'win-pro', platform: 'win32', updatedAt: '2026-09-20T11:36:28.004Z', stale: false },
            ],
          },
        },
        mockUsageOverview.hubs[1],
        {
          ...mockUsageOverview.hubs[2],
          state: receivedSapporoState,
        },
      ],
    },
    status: 'connected',
  },
] satisfies Array<{
  afterMs: number;
  overview?: UsageOverview;
  status: 'connected' | 'reconnecting';
}>;
