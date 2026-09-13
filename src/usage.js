import { deviceKey } from './identity.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// This describes the upstream collection scope, not a service-specific formula.
export function usageScope(tool) { return tool === 'cursor' ? 'account' : 'device'; }

export function usageTimestamp(device, tool) {
  const health = device?.observation?.clientHealth;
  return health?.clients?.[tool]?.collection?.lastSuccessAt ?? health?.observedAt;
}

export function usageError(device, tool) {
  if (!device || device.present === false) return 'missing_device';
  if (device.gapReason) return device.gapReason;
  if (device.metadata?.stale === true) return 'stale_device';
  if (!finite(device.observation?.periods?.allTime?.clientCosts?.[tool])) return 'missing_cost';
  if (!timestamp(usageTimestamp(device, tool))) return 'usage_time_missing';
  const client = device.observation.clientHealth?.clients?.[tool];
  if (!['healthy', 'waiting'].includes(client?.overall) || client.source?.state !== 'detected'
    || !['direct', 'ok'].includes(client.collection?.state)) return 'usage_unavailable';
  return null;
}

export function selectUsageSources(sources, devices, { requireHealthy = true } = {}) {
  const byDevice = new Map(devices.map(device => [deviceKey(device.hubId, device.deviceId), device]));
  const groups = new Map();
  const excluded = [];
  const duplicates = [];
  const describe = (source, reason) => ({ hubId: source.hubId, deviceId: source.deviceId, tool: source.tool, reason });
  for (const source of sources) {
    const device = byDevice.get(deviceKey(source.hubId, source.deviceId));
    const scope = usageScope(source.tool);
    let error = requireHealthy ? usageError(device, source.tool)
      : !finite(device?.observation?.periods?.allTime?.clientCosts?.[source.tool]) ? 'missing_cost' : null;
    const measuredAt = usageTimestamp(device, source.tool);
    if (!timestamp(measuredAt)) error ??= 'usage_time_missing';
    if (scope === 'account' && !source.accounts.length) error ??= 'missing_account';
    if (error) { excluded.push(describe(source, error)); continue; }
    const accounts = [...source.accounts].sort();
    const id = JSON.stringify(scope === 'account' ? [scope, source.tool, accounts] : [scope, source.tool, source.hubId, source.deviceId]);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push({ source, device, id, scope, measuredAt });
  }
  const selected = [];
  for (const reports of groups.values()) {
    const first = reports[0];
    if (first.scope === 'account' && [...groups.values()].some(other => other !== reports
      && other[0].source.tool === first.source.tool
      && other[0].source.accounts.some(account => first.source.accounts.includes(account)))) {
      excluded.push(...reports.map(report => describe(report.source, 'overlapping_usage')));
      continue;
    }
    reports.sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt)
      || deviceKey(a.source.hubId, a.source.deviceId).localeCompare(deviceKey(b.source.hubId, b.source.deviceId)));
    const latest = reports[0];
    if (reports.some(report => Date.parse(report.measuredAt) === Date.parse(latest.measuredAt)
      && report.device.observation.periods.allTime.clientCosts[report.source.tool]
        !== latest.device.observation.periods.allTime.clientCosts[latest.source.tool])) {
      excluded.push(...reports.map(report => describe(report.source, 'conflicting_usage')));
      continue;
    }
    selected.push(latest);
    duplicates.push(...reports.slice(1).map(report => describe(report.source, 'duplicate_usage')));
  }
  selected.sort((a, b) => a.id.localeCompare(b.id));
  return { selected, excluded, duplicates };
}
