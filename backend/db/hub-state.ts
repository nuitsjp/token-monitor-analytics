import type { DatabaseSync } from 'node:sqlite';
import type { HubUsageOverview } from '../../contracts/usage-overview.ts';

type JsonRecord = Record<string, unknown>;
type StoredPeriods = {
    today: { totalTokens: number; costUsd: number; clients: Record<string, number> };
    month: { totalTokens: number; costUsd: number; clients: Record<string, number> };
    allTime: { totalTokens: number; costUsd: number; clients: Record<string, number> };
};

const FRESHNESS_DEVICE_FIELDS = ['updatedAt', 'receivedAt', 'ageMs', 'stale'] as const;

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
    const statsJson = JSON.stringify(stats);
    withTransaction(db, () => {
        db.prepare(`
            INSERT INTO hub_states (hub_id, stats_json, received_at)
            VALUES (?, ?, ?)
            ON CONFLICT (hub_id) DO UPDATE SET
                stats_json = excluded.stats_json,
                received_at = excluded.received_at
        `).run(hubId, statsJson, receivedAt);
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
            today: { totalTokens: periods.today.totalTokens, costUsd: periods.today.costUsd, clients: periods.today.clients },
            month: { totalTokens: periods.month.totalTokens, costUsd: periods.month.costUsd, clients: periods.month.clients },
            total: { totalTokens: periods.allTime.totalTokens, costUsd: periods.allTime.costUsd, clients: periods.allTime.clients },
        },
        devices,
        activeDays,
    };
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
