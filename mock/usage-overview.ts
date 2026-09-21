import type { HubLimitWindow, UsageOverview } from '../contracts/usage-overview.ts';

const TOKYO_CODEX_PRO: HubLimitWindow[] = [
  {
    provider: 'codex',
    accountKey: 'codex-pro',
    accountLabel: 'Pro 5x',
    planLabel: '',
    kind: 'weekly',
    label: '',
    remainingPercent: 8,
    resetsAt: '2026-09-28T08:00:00.000Z',
    meterUpdatedAt: '2026-09-21T10:00:00.000Z',
    windowMinutes: 10080,
    limitId: 'codex',
  },
  {
    provider: 'codex',
    accountKey: 'codex-pro',
    accountLabel: 'Pro 5x',
    planLabel: '',
    kind: 'session',
    label: 'GPT-5.3-Codex-Spark',
    remainingPercent: 100,
    resetsAt: '2026-09-21T16:36:14.718Z',
    meterUpdatedAt: '2026-09-21T09:50:00.000Z',
    windowMinutes: 300,
    limitId: 'codex_bengalfox',
  },
];

const TOKYO_CODEX_PLUS: HubLimitWindow[] = [
  {
    provider: 'codex',
    accountKey: 'codex-plus',
    accountLabel: 'Plus',
    planLabel: '',
    kind: 'weekly',
    label: '',
    remainingPercent: 24,
    resetsAt: '2026-09-27T09:00:00.000Z',
    meterUpdatedAt: '2026-09-21T11:40:00.000Z',
    windowMinutes: 10080,
    limitId: 'codex',
  },
  {
    provider: 'codex',
    accountKey: 'codex-plus',
    accountLabel: 'Plus',
    planLabel: '',
    kind: 'session',
    label: '',
    remainingPercent: 99,
    resetsAt: '2026-09-21T16:35:52.004Z',
    meterUpdatedAt: '2026-09-21T12:10:00.000Z',
    windowMinutes: 300,
    limitId: 'codex',
  },
];

const TOKYO_CURSOR: HubLimitWindow[] = [
  {
    provider: 'cursor',
    accountKey: 'cursor-pro',
    accountLabel: '',
    planLabel: 'Pro',
    kind: 'billing',
    label: 'Cursor Models',
    remainingPercent: 15.4,
    resetsAt: '2026-09-22T10:00:00.000Z',
    meterUpdatedAt: '2026-09-21T11:00:00.000Z',
    windowMinutes: null,
  },
  {
    provider: 'cursor',
    accountKey: 'cursor-pro',
    accountLabel: '',
    planLabel: 'Pro',
    kind: 'billing',
    label: 'Other Models',
    remainingPercent: 0,
    resetsAt: '2026-09-20T10:00:00.000Z',
    meterUpdatedAt: '2026-09-21T10:50:00.000Z',
    windowMinutes: null,
  },
  {
    provider: 'cursor',
    accountKey: 'cursor-pro',
    accountLabel: '',
    planLabel: 'Pro',
    kind: 'weekly',
    label: 'Grok Bot',
    remainingPercent: 100,
    resetsAt: null,
    meterUpdatedAt: '2026-09-21T10:40:00.000Z',
    windowMinutes: null,
  },
];

const TOKYO_GROK: HubLimitWindow[] = [
  {
    provider: 'grok',
    accountKey: 'grok-super',
    accountLabel: 'SuperGrok',
    planLabel: '',
    kind: 'billing',
    label: 'Weekly',
    remainingPercent: 98,
    resetsAt: '2026-09-25T06:00:00.000Z',
    meterUpdatedAt: '2026-09-21T09:00:00.000Z',
    windowMinutes: 10080,
  },
];

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
        limits: [...TOKYO_CODEX_PRO, ...TOKYO_CODEX_PLUS, ...TOKYO_CURSOR, ...TOKYO_GROK],
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
        limits: [
          {
            provider: 'codex',
            accountKey: 'codex-pro',
            accountLabel: 'Pro 5x',
            planLabel: '',
            kind: 'weekly',
            label: '',
            remainingPercent: 40,
            resetsAt: '2026-09-28T08:00:00.000Z',
            meterUpdatedAt: '2026-09-21T09:00:00.000Z',
            windowMinutes: 10080,
            limitId: 'codex',
          },
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
