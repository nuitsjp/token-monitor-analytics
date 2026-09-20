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
  devices: HubDeviceOverview[];
}

export interface HubDeviceOverview {
  deviceId: string;
  hostname: string;
  platform: string;
  updatedAt: string;
  stale: boolean;
}
