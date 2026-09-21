import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect, type ControlledHub } from './fixtures.ts';

type JsonRecord = Record<string, unknown>;
const sourceStats = JSON.parse(readFileSync(
    resolve('docs/reference/hub-private/2026-09-12T01-57-13-988Z/stats.json'), 'utf8',
)) as JsonRecord;

test('2つのHubの最新状態を保存し、再起動後も維持する', async ({ app, hubs }) => {
    await waitForConnections(hubs, [1, 1]);
    const statsA = statsAt('2026-09-20T12:00:00.000Z');
    const statsB = statsAt('2026-09-20T12:01:00.000Z');
    statsB.devices = [];
    sendStats(hubs[0], 'snapshot', statsA);
    sendStats(hubs[1], 'snapshot', statsB);

    await expect.poll(() => readStates(app.databasePath)).toEqual([
        { hubId: 'hub-a', name: 'Hub A', updatedAt: statsA.updatedAt, deviceCount: 2 },
        { hubId: 'hub-b', name: 'Hub B', updatedAt: statsB.updatedAt, deviceCount: 0 },
    ]);

    sendStats(hubs[0], 'stats', statsA);
    sendStats(hubs[0], 'stats', statsA);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a')).toBe(
        ((statsA.periods as JsonRecord).today as JsonRecord).totalTokens,
    );
    expect(databaseText(app.databasePath)).not.toContain(hubs[0].token);
    expect(databaseText(app.databasePath)).not.toContain(hubs[0].origin);
    expect(app.output).not.toContain(hubs[0].token);
    expect(app.output).not.toContain(hubs[1].token);

    await app.restart();
    await waitForConnections(hubs, [1, 1]);
    expect(readStates(app.databasePath)).toEqual([
        { hubId: 'hub-a', name: 'Hub A', updatedAt: statsA.updatedAt, deviceCount: 2 },
        { hubId: 'hub-b', name: 'Hub B', updatedAt: statsB.updatedAt, deviceCount: 0 },
    ]);
});

test('通信断後に当該Hubへ再接続し、切断中は保存値と他Hubを維持する', async ({ app, hubs, request }) => {
    await waitForConnections(hubs, [1, 1]);
    const statsA = statsAt('2026-09-21T14:00:00.000Z');
    const statsB = statsAt('2026-09-21T14:01:00.000Z');
    sendStats(hubs[0], 'snapshot', statsA);
    sendStats(hubs[1], 'snapshot', statsB);
    await expect.poll(() => readStates(app.databasePath).length).toBe(2);

    hubs[0].endConnections();
    await waitForConnections(hubs, [0, 1]);
    expect(readState(app.databasePath, 'hub-a').updatedAt).toBe(statsA.updatedAt);
    const continuedB = statsAt('2026-09-21T14:02:00.000Z');
    ((continuedB.periods as JsonRecord).today as JsonRecord).totalTokens = 777;
    sendStats(hubs[1], 'stats', continuedB);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-b')).toBe(777);
    const health = await request.get('/health');
    expect(health.ok()).toBe(true);

    await waitForConnections(hubs, [1, 1]);
    expect(hubs.map(hub => hub.activeConnections)).toEqual([1, 1]);
    const restoredA = statsAt('2026-09-21T14:03:00.000Z');
    sendStats(hubs[0], 'snapshot', restoredA);
    await expect.poll(() => readState(app.databasePath, 'hub-a').updatedAt).toBe(restoredA.updatedAt);

    hubs[0].dropConnections();
    await waitForConnections(hubs, [0, 1]);
    await waitForConnections(hubs, [1, 1]);
    const restoredA2 = statsAt('2026-09-21T14:04:00.000Z');
    sendStats(hubs[0], 'snapshot', restoredA2);
    await expect.poll(() => readState(app.databasePath, 'hub-a').updatedAt).toBe(restoredA2.updatedAt);

    hubs[0].send('stats', { type: 'stats', stats: {} });
    await waitForConnections(hubs, [0, 1]);
    await new Promise(resolve => setTimeout(resolve, 4000));
    expect(hubs.map(hub => hub.activeConnections)).toEqual([0, 1]);
    expect(readState(app.databasePath, 'hub-a').updatedAt).toBe(restoredA2.updatedAt);
    expect(app.output).toMatch(/"cause":"(disconnected|connection)"/);
    expect(app.output).toContain('"cause":"invalid-notification"');
    expect(app.output).not.toContain(hubs[0].token);
    expect(app.output).not.toContain(hubs[1].token);
});

test('HTTP 401では当該Hubを再接続しない', async ({ app, hubs, request }) => {
    await waitForConnections(hubs, [1, 1]);
    hubs[0].rejectNewConnections();
    hubs[0].dropConnections();
    await expect.poll(() => app.output).toContain('"cause":"response"');
    await new Promise(resolve => setTimeout(resolve, 4000));
    expect(hubs.map(hub => hub.activeConnections)).toEqual([0, 1]);
    const health = await request.get('/health');
    expect(health.ok()).toBe(true);
    expect(await health.json()).toEqual({ status: 'ok' });
});

test('一方の不正通知で他方の受信とWebを停止しない', async ({ app, hubs, request }) => {
    await waitForConnections(hubs, [1, 1]);
    const statsA = statsAt('2026-09-20T13:00:00.000Z');
    const statsB = statsAt('2026-09-20T13:01:00.000Z');
    sendStats(hubs[0], 'snapshot', statsA);
    sendStats(hubs[1], 'snapshot', statsB);
    await expect.poll(() => readStates(app.databasePath).length).toBe(2);

    hubs[0].send('stats', { type: 'stats', stats: {} });
    await waitForConnections(hubs, [0, 1]);
    const updatedB = statsAt('2026-09-20T13:02:00.000Z');
    ((updatedB.periods as JsonRecord).today as JsonRecord).totalTokens = 777;
    sendStats(hubs[1], 'stats', updatedB);

    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-b')).toBe(777);
    expect(readState(app.databasePath, 'hub-a').updatedAt).toBe(statsA.updatedAt);
    const health = await request.get('/health');
    expect(health.ok()).toBe(true);
    expect(await health.json()).toEqual({ status: 'ok' });
});

function statsAt(updatedAt: string): JsonRecord {
    const stats = structuredClone(sourceStats);
    stats.updatedAt = updatedAt;
    return stats;
}

function sendStats(hub: ControlledHub, event: 'snapshot' | 'stats', stats: JsonRecord): void {
    hub.send(event, { type: 'stats', reason: event, stats, at: stats.updatedAt });
}

async function waitForConnections(hubs: ControlledHub[], counts: number[]): Promise<void> {
    await expect.poll(() => hubs.map(hub => hub.activeConnections)).toEqual(counts);
}

function readStates(path: string) {
    return withDatabase(path, db => db.prepare(`
        SELECT h.hub_id, h.name, s.stats_json
        FROM hubs h JOIN hub_states s ON s.hub_id = h.hub_id
        ORDER BY h.hub_id
    `).all().map(row => {
        const typed = row as { hub_id: string; name: string; stats_json: string };
        const stats = JSON.parse(typed.stats_json) as JsonRecord;
        return { hubId: typed.hub_id, name: typed.name, updatedAt: stats.updatedAt,
            deviceCount: (stats.devices as unknown[]).length };
    }));
}

function readState(path: string, hubId: string): JsonRecord {
    return withDatabase(path, db => {
        const row = db.prepare('SELECT stats_json FROM hub_states WHERE hub_id = ?').get(hubId) as { stats_json: string };
        return JSON.parse(row.stats_json) as JsonRecord;
    });
}

function readTotalTokens(path: string, hubId: string): unknown {
    const stats = readState(path, hubId);
    return ((stats.periods as JsonRecord).today as JsonRecord).totalTokens;
}

function databaseText(path: string): string {
    return withDatabase(path, db => JSON.stringify(db.prepare(`
        SELECT h.hub_id, h.name, s.stats_json, s.received_at
        FROM hubs h LEFT JOIN hub_states s ON s.hub_id = h.hub_id
    `).all()));
}

function withDatabase<T>(path: string, operation: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return operation(db); }
    finally { db.close(); }
}
