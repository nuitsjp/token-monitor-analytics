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
  periods: Record<'today' | 'month' | 'total', UsagePeriod>;
  devices: HubDeviceOverview[];
  activeDays?: number;
}

export interface UsagePeriod {
  totalTokens: number;
  costUsd: number;
  clients?: Record<string, number>;
}

export interface HubDeviceOverview {
  deviceId: string;
  hostname: string;
  platform: string;
  updatedAt: string;
  stale: boolean;
}
