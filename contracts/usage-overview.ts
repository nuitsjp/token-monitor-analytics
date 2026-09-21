export interface UsageOverview {
  hubs: HubUsageOverview[];
}

export interface HubUsageOverview {
  hubId: string;
  name: string;
  state: HubDeviceState | null;
}

export interface PeriodUsage {
  totalTokens: number;
  costUsd: number;
  clients?: Record<string, number>;
  models?: Record<string, number>;
}

export type UsagePeriod = PeriodUsage;

export interface HubDeviceState {
  updatedAt: string;
  receivedAt: string;
  periods: Record<'today' | 'month' | 'total', PeriodUsage>;
  devices: HubDeviceOverview[];
  activeDays?: number;
}

export interface HubDeviceOverview {
  deviceId: string;
  hostname: string;
  platform: string;
  updatedAt: string;
  stale: boolean;
}
