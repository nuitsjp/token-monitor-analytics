export interface UsageOverview {
  hubs: HubUsageOverview[];
}

export interface HubUsageOverview {
  hubId: string;
  name: string;
  usage: AvailableHubUsage | null;
}

export interface AvailableHubUsage {
  todayTokens: number;
  todayCostUsd: number;
  deviceCount: number;
  updatedAt: string;
}
