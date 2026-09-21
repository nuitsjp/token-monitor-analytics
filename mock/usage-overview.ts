import type { UsageOverview } from '../contracts/usage-overview.ts';

export const mockUsageOverview: UsageOverview = {
  hubs: [
    {
      hubId: 'tokyo',
      name: 'Tokyo Hub',
      state: {
        updatedAt: '2026-09-21T11:36:14.718Z',
        receivedAt: '2026-09-21T11:36:15.012Z',
        activeDays: 15,
        periods: {
          today: {
            totalTokens: 42621015,
            costUsd: 29.89,
            models: {
              'gpt-5.6-luna': 25000000,
              'gpt-5.6-sol': 12000000,
              'gpt-6-astra': 5621015,
            },
          },
          month: {
            totalTokens: 3862063575,
            costUsd: 1561.13,
            models: {
              'gpt-5.6-luna': 1800000000,
              'gpt-5.6-sol': 900000000,
              'gpt-6-astra': 500000000,
              'gemini-3.8-flash': 350000000,
              'claude-4-sonnet': 150000000,
              'claude-4-haiku': 80000000,
              'gpt-5.2': 50000000,
              'o3-mini': 20000000,
              'o3-max': 10000000,
              'llama-3.3-70b': 2063575,
            },
          },
          total: {
            totalTokens: 24419264000,
            costUsd: 9869.05,
            models: {
              'gpt-5.6-luna': 12000000000,
              'gpt-5.6-sol': 6000000000,
              'gpt-6-astra': 3000000000,
              'gemini-3.8-flash': 2000000000,
              'claude-4-sonnet': 800000000,
              'claude-4-haiku': 400000000,
              'gpt-5.2': 150000000,
              'o3-mini': 50000000,
              'llama-3.3-70b': 19264000,
            },
          },
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
          today: {
            totalTokens: 8729605,
            costUsd: 6.12,
            models: {
              'gemini-3.8-flash': 8729605,
            },
          },
          month: {
            totalTokens: 791025069,
            costUsd: 319.75,
            models: {
              'gpt-5.6-luna': 300000000,
              'gpt-5.6-sol': 220000000,
              'gemini-3.8-flash': 120000000,
              'mistral-large': 70000000,
              'qwen-2.5-coder': 50000000,
              'deepseek-r1': 31025069,
            },
          },
          total: {
            totalTokens: 5001536000,
            costUsd: 2021.37,
            models: {
              'gpt-5.6-luna': 2000000000,
              'gpt-5.6-sol': 1500000000,
              'gemini-3.8-flash': 800000000,
              'mistral-large': 400000000,
              'qwen-2.5-coder': 200000000,
              'deepseek-r1': 101536000,
            },
          },
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
