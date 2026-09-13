import { providerContractId, deviceKey } from './identity.js';
import { selectUsageSources, usageScope } from './usage.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);

export function buildMetrics(hubs, devices, registry) {
  const bySource = new Map(registry.map(source => [JSON.stringify([source.hubId, source.deviceId, source.tool]), source]));
  const reports = devices.filter(device => device.present !== false).flatMap(device => {
    const costs = device.observation.periods?.allTime?.clientCosts ?? {};
    return Object.keys(costs).filter(tool => usageScope(tool) === 'account' && finite(costs[tool])).map(tool => (
      bySource.get(JSON.stringify([device.hubId, device.deviceId, tool])) ?? {
        hubId: device.hubId, deviceId: device.deviceId, tool,
        accounts: [...new Set((device.observation.limits?.providers ?? []).filter(provider => provider.provider === tool)
          .map(provider => providerContractId(provider, device.hubId)).filter(Boolean))].sort(),
      }
    ));
  });
  const byDevice = new Map(devices.map(device => [deviceKey(device.hubId, device.deviceId), device]));
  function calculate(selectedHubs) {
    const ids = new Set(selectedHubs.map(hub => hub.id));
    const sources = reports.filter(source => ids.has(source.hubId));
    const selection = selectUsageSources(sources, devices, { requireHealthy: false });
    const periods = Object.fromEntries(['today', 'month', 'allTime'].map(period => [period,
      Object.fromEntries([['costUsd', 'clientCosts'], ['totalTokens', 'clients']].map(([field, map]) => {
        const base = selectedHubs.map(hub => hub.aggregate?.periods?.[period]?.[field]);
        if (!base.length || base.some(value => !finite(value)) || selection.excluded.length) return [field, null];
        // Hub totals already contain the selected report. Only remove duplicate
        // contributions that actually exist in the upstream sparse period maps.
        const duplicates = selection.duplicates.map(source => byDevice.get(deviceKey(source.hubId, source.deviceId))
          .observation.periods?.[period]?.[map]?.[source.tool]).filter(finite);
        return [field, base.reduce((a, b) => a + b, 0) - duplicates.reduce((a, b) => a + b, 0)];
      }))]));
    return { periods, excludedSources: selection.excluded, duplicateSources: selection.duplicates };
  }
  return { global: calculate(hubs), byHub: new Map(hubs.map(hub => [hub.id, calculate([hub])])) };
}
