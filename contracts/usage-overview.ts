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
  models?: Record<string, number>;
}

export interface HubDeviceState {
  updatedAt: string;
  receivedAt: string;
  periods: Record<'today' | 'month' | 'total', PeriodUsage>;
  devices: HubDeviceOverview[];
  activeDays?: number;
  limits?: HubLimitWindow[];
}

export interface HubLimitWindow {
  provider: string;
  accountKey: string;
  accountLabel: string;
  planLabel: string;
  kind: 'session' | 'daily' | 'weekly' | 'billing';
  label: string;
  remainingPercent: number;
  resetsAt: string | null;
  meterUpdatedAt: string | null;
  windowMinutes: number | null;
  limitId?: string;
}

export interface HubDeviceOverview {
  deviceId: string;
  hostname: string;
  platform: string;
  updatedAt: string;
  stale: boolean;
}
