import type { DatabaseSync } from 'node:sqlite';
import type { HubLimitWindow, HubUsageOverview } from '../../contracts/usage-overview.ts';

type JsonRecord = Record<string, unknown>;
type StoredPeriods = {
    today: { totalTokens: number; costUsd: number };
    month: { totalTokens: number; costUsd: number };
    allTime: { totalTokens: number; costUsd: number };
};

const FRESHNESS_DEVICE_FIELDS = ['updatedAt', 'receivedAt', 'ageMs', 'stale'] as const;
const LIMIT_KINDS = ['session', 'daily', 'weekly', 'billing'] as const;

export function registerHub(db: DatabaseSync, hubId: string, name: string): void {
    db.prepare(`
        INSERT INTO hubs (hub_id, name)
        VALUES (?, ?)
        ON CONFLICT (hub_id) DO UPDATE SET name = excluded.name
    `).run(hubId, name);
}

export function readHubDeviceOverview(
    db: DatabaseSync,
    configuredHubs: readonly { id: string; name: string }[],
): HubUsageOverview[] {
    const rows = db.prepare(`
        SELECT h.hub_id, h.name, s.stats_json, s.received_at
        FROM hubs h
        LEFT JOIN hub_states s ON s.hub_id = h.hub_id
    `).all() as Array<{ hub_id: string; name: string; stats_json: string | null; received_at: string | null }>;
    const byId = new Map(rows.map(row => [row.hub_id, row]));

    return configuredHubs.map(hub => {
        const row = byId.get(hub.id);
        if (!row || row.stats_json === null || row.received_at === null)
            return { hubId: hub.id, name: hub.name, state: null };
        return {
            hubId: hub.id,
            name: row.name,
            state: parseHubDeviceState(row.stats_json, row.received_at),
        };
    });
}

export function saveHubState(
    db: DatabaseSync,
    hubId: string,
    stats: Record<string, unknown>,
    receivedAt: string,
): void {
    withTransaction(db, () => {
        const row = db.prepare('SELECT stats_json FROM hub_states WHERE hub_id = ?').get(hubId) as
            | { stats_json: string }
            | undefined;
        const previous = row ? JSON.parse(row.stats_json) as JsonRecord : null;
        stampLimitMeters(previous, stats, receivedAt);
        db.prepare(`
            INSERT INTO hub_states (hub_id, stats_json, received_at)
            VALUES (?, ?, ?)
            ON CONFLICT (hub_id) DO UPDATE SET
                stats_json = excluded.stats_json,
                received_at = excluded.received_at
        `).run(hubId, JSON.stringify(stats), receivedAt);
    });
}

export function updateHubFreshness(
    db: DatabaseSync,
    hubId: string,
    freshness: Record<string, unknown>,
    receivedAt: string,
): void {
    withTransaction(db, () => {
        const row = db.prepare('SELECT stats_json FROM hub_states WHERE hub_id = ?').get(hubId) as
            | { stats_json: string }
            | undefined;
        if (!row)
            throw new Error('Hubの保存済み状態がありません。');
        const stats = JSON.parse(row.stats_json) as JsonRecord;
        const nextStats = applyFreshness(stats, freshness);
        db.prepare(`
            INSERT INTO hub_states (hub_id, stats_json, received_at)
            VALUES (?, ?, ?)
            ON CONFLICT (hub_id) DO UPDATE SET
                stats_json = excluded.stats_json,
                received_at = excluded.received_at
        `).run(hubId, JSON.stringify(nextStats), receivedAt);
    });
}

function withTransaction<T>(db: DatabaseSync, operation: () => T): T {
    db.exec('BEGIN IMMEDIATE;');
    try {
        const result = operation();
        db.exec('COMMIT;');
        return result;
    }
    catch (error) {
        try {
            db.exec('ROLLBACK;');
        }
        catch {
            // Preserve the original database or serialization error.
        }
        throw error;
    }
}

function parseHubDeviceState(statsJson: string, receivedAt: string) {
    const stats = JSON.parse(statsJson) as JsonRecord;
    if (typeof stats.updatedAt !== 'string' || !Array.isArray(stats.devices))
        throw new Error('Hubの保存済み状態が不正です。');
    const periods = stats.periods as StoredPeriods;
    const devices = stats.devices.map(value => {
        const device = value as JsonRecord;
        if (typeof device.deviceId !== 'string' || typeof device.hostname !== 'string'
            || typeof device.platform !== 'string' || typeof device.updatedAt !== 'string'
            || typeof device.stale !== 'boolean') {
            throw new Error('Hubの保存済みデバイスが不正です。');
        }
        return {
            deviceId: device.deviceId,
            hostname: device.hostname,
            platform: device.platform,
            updatedAt: device.updatedAt,
            stale: device.stale,
        };
    });
    const historyPreview = stats.historyPreview as { summary?: { activeDays?: number } } | undefined;
    const activeDays = typeof historyPreview?.summary?.activeDays === 'number'
        ? historyPreview.summary.activeDays
        : 0;
    return {
        updatedAt: stats.updatedAt,
        receivedAt,
        periods: {
            today: { totalTokens: periods.today.totalTokens, costUsd: periods.today.costUsd },
            month: { totalTokens: periods.month.totalTokens, costUsd: periods.month.costUsd },
            total: { totalTokens: periods.allTime.totalTokens, costUsd: periods.allTime.costUsd },
        },
        devices,
        activeDays,
        limits: parseLimits(stats),
    };
}

function parseLimits(stats: JsonRecord): HubLimitWindow[] {
    const limits = stats.limits as JsonRecord | undefined;
    if (!limits || !Array.isArray(limits.providers))
        return [];
    const rows: HubLimitWindow[] = [];
    for (const value of limits.providers) {
        const provider = value as JsonRecord;
        if (typeof provider.provider !== 'string' || typeof provider.accountKey !== 'string' || !Array.isArray(provider.windows))
            continue;
        const providerUpdated = typeof provider.updatedAt === 'string' ? provider.updatedAt : null;
        for (const item of provider.windows) {
            const window = item as JsonRecord;
            if (window.showMeter !== true || !isLimitKind(window.kind)
                || typeof window.remainingPercent !== 'number' || !Number.isFinite(window.remainingPercent))
                continue;
            const parsed: HubLimitWindow = {
                provider: provider.provider,
                accountKey: provider.accountKey,
                accountLabel: typeof provider.accountLabel === 'string' ? provider.accountLabel : '',
                planLabel: typeof provider.planLabel === 'string' ? provider.planLabel : '',
                kind: window.kind,
                label: typeof window.label === 'string' ? window.label : '',
                remainingPercent: window.remainingPercent,
                resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : null,
                meterUpdatedAt: typeof window.meterUpdatedAt === 'string' ? window.meterUpdatedAt : providerUpdated,
                windowMinutes: typeof window.windowMinutes === 'number' && Number.isFinite(window.windowMinutes)
                    ? window.windowMinutes
                    : null,
            };
            if (typeof window.limitId === 'string')
                parsed.limitId = window.limitId;
            rows.push(parsed);
        }
    }
    return rows;
}

function stampLimitMeters(previous: JsonRecord | null, stats: JsonRecord, receivedAt: string): void {
    const previousMeters = previous ? collectWindowMeters(previous) : new Map<string, { remainingPercent: unknown; usedPercent: unknown; meterUpdatedAt: unknown }>();
    const limits = stats.limits as JsonRecord | undefined;
    if (!limits || !Array.isArray(limits.providers))
        return;
    for (const value of limits.providers) {
        const provider = value as JsonRecord;
        if (!Array.isArray(provider.windows))
            continue;
        const providerUpdated = typeof provider.updatedAt === 'string' ? provider.updatedAt : receivedAt;
        for (const item of provider.windows) {
            const window = item as JsonRecord;
            const previousMeter = previousMeters.get(windowIdentity(provider, window));
            const changed = !previousMeter
                || previousMeter.remainingPercent !== window.remainingPercent
                || previousMeter.usedPercent !== window.usedPercent;
            if (changed)
                window.meterUpdatedAt = providerUpdated;
            else if (typeof previousMeter.meterUpdatedAt === 'string')
                window.meterUpdatedAt = previousMeter.meterUpdatedAt;
            else
                window.meterUpdatedAt = providerUpdated;
        }
    }
}

function collectWindowMeters(stats: JsonRecord) {
    const meters = new Map<string, { remainingPercent: unknown; usedPercent: unknown; meterUpdatedAt: unknown }>();
    const limits = stats.limits as JsonRecord | undefined;
    if (!limits || !Array.isArray(limits.providers))
        return meters;
    for (const value of limits.providers) {
        const provider = value as JsonRecord;
        if (!Array.isArray(provider.windows))
            continue;
        for (const item of provider.windows) {
            const window = item as JsonRecord;
            meters.set(windowIdentity(provider, window), {
                remainingPercent: window.remainingPercent,
                usedPercent: window.usedPercent,
                meterUpdatedAt: window.meterUpdatedAt,
            });
        }
    }
    return meters;
}

function windowIdentity(provider: JsonRecord, window: JsonRecord) {
    const limitId = typeof window.limitId === 'string' ? window.limitId : '';
    const label = typeof window.label === 'string' ? window.label : '';
    return [provider.provider, provider.accountKey, window.kind, limitId || label].join('\0');
}

function isLimitKind(value: unknown): value is HubLimitWindow['kind'] {
    return typeof value === 'string' && LIMIT_KINDS.includes(value as HubLimitWindow['kind']);
}

function applyFreshness(stats: JsonRecord, freshness: JsonRecord): JsonRecord {
    const nextStats: JsonRecord = { ...stats };
    if (freshness.updatedAt)
        nextStats.updatedAt = freshness.updatedAt;
    if (Number.isFinite(freshness.staleAfterMs))
        nextStats.staleAfterMs = freshness.staleAfterMs;

    const incomingLimits = freshness.limits as JsonRecord | undefined;
    if (incomingLimits && Object.prototype.hasOwnProperty.call(incomingLimits, 'updatedAt')) {
        nextStats.limits = {
            ...(stats.limits as JsonRecord),
            updatedAt: incomingLimits.updatedAt,
        };
    }

    const currentDevices = stats.devices as JsonRecord[];
    const incomingDevices = freshness.devices as JsonRecord[];
    const byDeviceId = new Map<unknown, JsonRecord>();
    for (const device of incomingDevices)
        byDeviceId.set(device.deviceId, device);
    nextStats.devices = currentDevices.map((device) => {
        const update = byDeviceId.get(device.deviceId);
        if (!update)
            return device;
        const nextDevice: JsonRecord = { ...device };
        for (const field of FRESHNESS_DEVICE_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(update, field))
                nextDevice[field] = update[field];
        }
        return nextDevice;
    });
    return nextStats;
}
