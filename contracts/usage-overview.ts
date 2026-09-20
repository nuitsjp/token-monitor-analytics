export interface UsageOverview {
  hubs: HubUsageOverview[];
}

export interface HubUsageOverview {
  hubId: string;
  name: string;
  state: HubDeviceState | null;
}

export interface HubDeviceState {
  updatedAt: string;
  receivedAt: string;
  periods: Record<'today' | 'month' | 'total', { totalTokens: number; costUsd: number }>;
  devices: HubDeviceOverview[];
}

export interface HubDeviceOverview {
  deviceId: string;
  hostname: string;
  platform: string;
  updatedAt: string;
  stale: boolean;
}
