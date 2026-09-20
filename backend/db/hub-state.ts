import type { DatabaseSync } from 'node:sqlite';

type JsonRecord = Record<string, unknown>;

const FRESHNESS_DEVICE_FIELDS = ['updatedAt', 'receivedAt', 'ageMs', 'stale'] as const;

export function registerHub(db: DatabaseSync, hubId: string, name: string): void {
    db.prepare(`
        INSERT INTO hubs (hub_id, name)
        VALUES (?, ?)
        ON CONFLICT (hub_id) DO UPDATE SET name = excluded.name
    `).run(hubId, name);
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
