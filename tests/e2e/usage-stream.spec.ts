import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { HubUsageOverview, UsageOverview } from '../../contracts/usage-overview.ts';
import { test, expect, type ControlledHub } from './fixtures.ts';

type JsonRecord = Record<string, unknown>;

const sourceStats = JSON.parse(readFileSync(
    resolve('docs/reference/hub-private/2026-09-12T01-57-13-988Z/stats.json'), 'utf8',
)) as JsonRecord;

class StreamDeadlineError extends Error {}
class StreamClosedError extends Error {}

type UsageStream = {
    nextUpdate: (deadlineMs?: number) => Promise<UsageOverview>;
    waitForClose: (deadlineMs?: number) => Promise<void>;
    close: () => Promise<void>;
};

test('初回・保存後のsnapshot/stats/freshnessを複数購読へ配信し、再接続で最新値を返す', async ({ app, hubs }) => {
    await waitForConnections(hubs, [1, 1]);
    const streams: UsageStream[] = [];
    try {
        const first = await openUsageStream(app.url);
        streams.push(first);
        const second = await openUsageStream(app.url);
        streams.push(second);
        const initial = readOverview(app.databasePath);
        expect(initial.hubs.every(hub => hub.state === null)).toBe(true);
        expect(await first.nextUpdate()).toEqual(initial);
        expect(await second.nextUpdate()).toEqual(initial);

        const snapshotA = statsAt('2026-09-21T06:00:00.000Z');
        sendStats(hubs[0], 'snapshot', snapshotA);
        await expectBothUpdates(first, second, app.databasePath);

        const snapshotB = statsAt('2026-09-21T06:01:00.000Z');
        sendStats(hubs[1], 'snapshot', snapshotB);
        await expectBothUpdates(first, second, app.databasePath);

        const updatedA = statsAt('2026-09-21T06:02:00.000Z');
        setPeriod(updatedA, 'today', 4_321_000, 43.21);
        sendStats(hubs[0], 'stats', updatedA);
        await expectBothUpdates(first, second, app.databasePath);

        const freshA = freshnessAt(updatedA, '2026-09-21T06:03:00.000Z');
        sendFreshness(hubs[0], freshA);
        const freshnessUpdate = await expectBothUpdates(first, second, app.databasePath);
        const freshnessState = freshnessUpdate.hubs.find(hub => hub.hubId === 'hub-a')?.state;
        expect(freshnessState?.periods.today).toEqual({ totalTokens: 4_321_000, costUsd: 43.21 });

        await second.close();
        const updatedB = statsAt('2026-09-21T06:04:00.000Z');
        sendStats(hubs[1], 'stats', updatedB);
        const latest = await first.nextUpdate();
        expect(latest).toEqual(readOverview(app.databasePath));
        const serialized = JSON.stringify(latest);
        for (const hub of hubs) {
            expect(serialized).not.toContain(hub.token);
            expect(serialized).not.toContain(hub.origin);
        }
        expect(databaseText(app.databasePath)).not.toContain(hubs[0].token);
        expect(databaseText(app.databasePath)).not.toContain(hubs[1].token);
        expect(databaseText(app.databasePath)).not.toContain(hubs[0].origin);
        expect(databaseText(app.databasePath)).not.toContain(hubs[1].origin);
        expect(app.output).not.toContain(hubs[0].token);
        expect(app.output).not.toContain(hubs[1].token);

        await first.close();
        const reconnected = await openUsageStream(app.url);
        streams.push(reconnected);
        expect(await reconnected.nextUpdate()).toEqual(readOverview(app.databasePath));
    }
    finally {
        await Promise.all(streams.map(stream => stream.close()));
    }
});

test('Hub切断中は閲覧へ更新せず、再接続後の保存で最新値を配信する', async ({ app, hubs }) => {
    await waitForConnections(hubs, [1, 1]);
    const snapshotA = statsAt('2026-09-21T15:00:00.000Z');
    const snapshotB = statsAt('2026-09-21T15:01:00.000Z');
    sendStats(hubs[0], 'snapshot', snapshotA);
    sendStats(hubs[1], 'snapshot', snapshotB);
    await expect.poll(() => readRawStats(app.databasePath, 'hub-a')?.updatedAt).toBe(snapshotA.updatedAt);
    await expect.poll(() => readRawStats(app.databasePath, 'hub-b')?.updatedAt).toBe(snapshotB.updatedAt);

    const stream = await openUsageStream(app.url);
    try {
        expect(await stream.nextUpdate()).toEqual(readOverview(app.databasePath));
        hubs[0].endConnections();
        await waitForConnections(hubs, [0, 1]);
        await new Promise(resolve => setTimeout(resolve, 1500));
        expect(readRawStats(app.databasePath, 'hub-a')?.updatedAt).toBe(snapshotA.updatedAt);

        const continuedB = statsAt('2026-09-21T15:02:00.000Z');
        sendStats(hubs[1], 'stats', continuedB);
        const otherUpdate = await stream.nextUpdate();
        expect(otherUpdate).toEqual(readOverview(app.databasePath));
        expect(otherUpdate.hubs.find(hub => hub.hubId === 'hub-b')?.state?.updatedAt).toBe(continuedB.updatedAt);

        await waitForConnections(hubs, [1, 1]);
        const restoredA = statsAt('2026-09-21T15:03:00.000Z');
        sendStats(hubs[0], 'snapshot', restoredA);
        const restored = await stream.nextUpdate();
        expect(restored).toEqual(readOverview(app.databasePath));
        expect(restored.hubs.find(hub => hub.hubId === 'hub-a')?.state?.updatedAt).toBe(restoredA.updatedAt);
    }
    finally {
        await stream.close();
    }
});

test('heartbeat・不正通知・保存失敗は配信せず、保存値と他Hubの受信を維持する', async ({ app, hubs }) => {
    await waitForConnections(hubs, [1, 1]);
    const streams: UsageStream[] = [];
    const initial = readOverview(app.databasePath);
    try {
        const heartbeatStream = await openUsageStream(app.url);
        streams.push(heartbeatStream);
        expect(await heartbeatStream.nextUpdate()).toEqual(initial);
        hubs[0].sendRaw(': heartbeat\n\n');
        await expectNoUpdate(heartbeatStream);

        const invalidStream = await openUsageStream(app.url);
        streams.push(invalidStream);
        expect(await invalidStream.nextUpdate()).toEqual(initial);
        hubs[0].send('stats', { type: 'stats', reason: 'invalid', stats: {}, at: 'invalid' });
        await waitForConnections(hubs, [0, 1]);
        await expectNoUpdate(invalidStream);
        expect(readOverview(app.databasePath)).toEqual(initial);

        const otherStream = await openUsageStream(app.url);
        streams.push(otherStream);
        expect(await otherStream.nextUpdate()).toEqual(initial);
        const snapshotB = statsAt('2026-09-21T07:00:00.000Z');
        sendStats(hubs[1], 'snapshot', snapshotB);
        const update = await otherStream.nextUpdate();
        expect(update).toEqual(readOverview(app.databasePath));
        expect(update.hubs.find(hub => hub.hubId === 'hub-b')?.state?.updatedAt).toBe(snapshotB.updatedAt);

        await otherStream.close();
        await app.restart();
        await waitForConnections(hubs, [1, 1]);
        const normalSaveStream = await openUsageStream(app.url);
        streams.push(normalSaveStream);
        await normalSaveStream.nextUpdate();
        const resumedB = statsAt('2026-09-21T07:00:30.000Z');
        sendStats(hubs[1], 'snapshot', resumedB);
        await normalSaveStream.nextUpdate();
        const priorA = statsAt('2026-09-21T07:01:00.000Z');
        sendStats(hubs[0], 'snapshot', priorA);
        await normalSaveStream.nextUpdate();
        await expect.poll(() => readStoredState(app.databasePath, 'hub-a')?.stats.updatedAt).toBe(priorA.updatedAt);
        const savedBeforeFailure = readStoredState(app.databasePath, 'hub-a');
        expect(savedBeforeFailure).toBeDefined();

        installSaveFailure(app.databasePath, 'hub-a');
        sendStats(hubs[0], 'stats', statsAt('2026-09-21T07:02:00.000Z'));
        await waitForConnections(hubs, [0, 1]);
        await expect.poll(() => app.output).toContain('"cause":"database"');
        await expectNoUpdate(normalSaveStream);
        expect(readStoredState(app.databasePath, 'hub-a')).toEqual(savedBeforeFailure);

        const continuedStream = await openUsageStream(app.url);
        streams.push(continuedStream);
        await continuedStream.nextUpdate();
        const continuedB = statsAt('2026-09-21T07:03:00.000Z');
        sendStats(hubs[1], 'stats', continuedB);
        const continuedUpdate = await continuedStream.nextUpdate();
        expect(continuedUpdate).toEqual(readOverview(app.databasePath));
        expect(continuedUpdate.hubs.find(hub => hub.hubId === 'hub-b')?.state?.updatedAt).toBe(continuedB.updatedAt);
    }
    finally {
        await Promise.all(streams.map(stream => stream.close()));
    }
});

test('読出失敗では初回503と既存接続終了を返し、保存継続と復旧後の再購読を可能にする', async ({ app, hubs }) => {
    await waitForConnections(hubs, [1, 1]);
    const initialA = statsAt('2026-09-21T09:00:00.000Z');
    const initialB = statsAt('2026-09-21T09:01:00.000Z');
    sendStats(hubs[0], 'snapshot', initialA);
    await expect.poll(() => readRawStats(app.databasePath, 'hub-a')?.updatedAt).toBe(initialA.updatedAt);
    sendStats(hubs[1], 'snapshot', initialB);
    await expect.poll(() => readRawStats(app.databasePath, 'hub-b')?.updatedAt).toBe(initialB.updatedAt);

    const streams: UsageStream[] = [];
    try {
        const live = await openUsageStream(app.url);
        streams.push(live);
        expect(await live.nextUpdate()).toEqual(readOverview(app.databasePath));
        corruptState(app.databasePath, 'hub-b');

        const updatedA = statsAt('2026-09-21T09:02:00.000Z');
        sendStats(hubs[0], 'stats', updatedA);
        await expect.poll(() => readRawStats(app.databasePath, 'hub-a')?.updatedAt).toBe(updatedA.updatedAt);
        await live.waitForClose();

        const unavailable = await fetch(streamUrl(app.url), { headers: { Accept: 'text/event-stream' } });
        expect(unavailable.status).toBe(503);
        expect(await unavailable.json()).toEqual({ message: '利用状況を取得できませんでした。' });

        const repairedB = statsAt('2026-09-21T09:03:00.000Z');
        sendStats(hubs[1], 'stats', repairedB);
        await expect.poll(() => readRawStats(app.databasePath, 'hub-b')?.updatedAt).toBe(repairedB.updatedAt);

        const recovered = await openUsageStream(app.url);
        streams.push(recovered);
        expect(await recovered.nextUpdate()).toEqual(readOverview(app.databasePath));
    }
    finally {
        await Promise.all(streams.map(stream => stream.close()));
    }
});

test('購読中の再起動を正常終了し、再購読時に最新保存値を再配信する', async ({ app, hubs }) => {
    await waitForConnections(hubs, [1, 1]);
    const snapshotA = statsAt('2026-09-21T10:00:00.000Z');
    const snapshotB = statsAt('2026-09-21T10:01:00.000Z');
    sendStats(hubs[0], 'snapshot', snapshotA);
    await expect.poll(() => readRawStats(app.databasePath, 'hub-a')?.updatedAt).toBe(snapshotA.updatedAt);
    sendStats(hubs[1], 'snapshot', snapshotB);
    await expect.poll(() => readRawStats(app.databasePath, 'hub-b')?.updatedAt).toBe(snapshotB.updatedAt);

    const subscribed = await openUsageStream(app.url);
    try {
        const latest = readOverview(app.databasePath);
        expect(await subscribed.nextUpdate()).toEqual(latest);
        const previousPid = app.pid;
        await app.restart();
        await subscribed.waitForClose();
        expect(app.pid).not.toBe(previousPid);
        await waitForConnections(hubs, [1, 1]);

        const reconnected = await openUsageStream(app.url);
        try {
            expect(await reconnected.nextUpdate()).toEqual(readOverview(app.databasePath));
        }
        finally {
            await reconnected.close();
        }
    }
    finally {
        await subscribed.close();
    }
});

async function openUsageStream(baseUrl: string): Promise<UsageStream> {
    const controller = new AbortController();
    let response: Response;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        response = await Promise.race([
            fetch(streamUrl(baseUrl), {
                headers: { Accept: 'text/event-stream' },
                signal: controller.signal,
            }),
            new Promise<never>((_, reject) => {
                connectTimer = setTimeout(() => reject(new StreamDeadlineError('SSE接続の期限を超えました')), 5000);
            }),
        ]);
    }
    catch (error) {
        controller.abort();
        throw error;
    }
    finally {
        if (connectTimer)
            clearTimeout(connectTimer);
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!response.ok || !response.body || !contentType.startsWith('text/event-stream')) {
        await response.body?.cancel();
        controller.abort();
        throw new Error(`SSE接続に失敗しました: ${response.status} ${contentType}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let closed = false;

    const readChunk = async (deadlineMs: number): Promise<ReadableStreamReadResult<Uint8Array>> => {
        const remaining = deadlineMs;
        if (remaining <= 0)
            throw new StreamDeadlineError('SSE読み取りの期限を超えました');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                reader.read(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new StreamDeadlineError('SSE読み取りの期限を超えました')), remaining);
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    };

    const nextFrame = async (deadlineMs: number): Promise<{ event: string; data: string }> => {
        const deadline = Date.now() + deadlineMs;
        while (true) {
            const separator = buffer.indexOf('\n\n');
            if (separator >= 0) {
                const frame = buffer.slice(0, separator);
                buffer = buffer.slice(separator + 2);
                return parseSseFrame(frame);
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                throw new StreamDeadlineError('SSEフレームの期限を超えました');
            const chunk = await readChunk(remaining);
            if (chunk.done) {
                closed = true;
                throw new StreamClosedError('SSE接続が終了しました');
            }
            buffer += decoder.decode(chunk.value, { stream: true });
        }
    };

    return {
        nextUpdate: async (deadlineMs = 5000) => {
            const frame = await nextFrame(deadlineMs);
            if (frame.event !== 'update')
                throw new Error(`予期しないSSEイベントです: ${frame.event}`);
            return JSON.parse(frame.data) as UsageOverview;
        },
        waitForClose: async (deadlineMs = 5000) => {
            const deadline = Date.now() + deadlineMs;
            while (true) {
                const remaining = deadline - Date.now();
                if (remaining <= 0)
                    throw new StreamDeadlineError('SSE終了待ちの期限を超えました');
                try {
                    const chunk = await readChunk(remaining);
                    if (chunk.done) {
                        closed = true;
                        return;
                    }
                }
                catch (error) {
                    if (error instanceof StreamDeadlineError)
                        throw error;
                    closed = true;
                    return;
                }
            }
        },
        close: async () => {
            if (closed)
                return;
            closed = true;
            controller.abort();
            try {
                await reader.cancel();
            }
            catch {
                // The server may have already closed the response.
            }
        },
    };
}

function parseSseFrame(frame: string): { event: string; data: string } {
    let event = '';
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:'))
            event = line.slice('event:'.length).trimStart();
        if (line.startsWith('data:'))
            data.push(line.slice('data:'.length).trimStart());
    }
    return { event, data: data.join('\n') };
}

async function expectBothUpdates(first: UsageStream, second: UsageStream, databasePath: string): Promise<UsageOverview> {
    const [firstUpdate, secondUpdate] = await Promise.all([first.nextUpdate(), second.nextUpdate()]);
    const stored = readOverview(databasePath);
    expect(firstUpdate).toEqual(stored);
    expect(secondUpdate).toEqual(stored);
    return firstUpdate;
}

async function expectNoUpdate(stream: UsageStream, deadlineMs = 750): Promise<void> {
    let failure: unknown;
    try {
        await stream.nextUpdate(deadlineMs);
        failure = new Error('通知がないはずのSSE接続に更新が届きました');
    }
    catch (error) {
        if (!(error instanceof StreamDeadlineError))
            failure = error;
    }
    finally {
        await stream.close();
    }
    if (failure)
        throw failure;
}

function statsAt(updatedAt: string): JsonRecord {
    const stats = structuredClone(sourceStats);
    stats.updatedAt = updatedAt;
    return stats;
}

function setPeriod(stats: JsonRecord, period: 'today' | 'month' | 'allTime', totalTokens: number, costUsd: number): void {
    const periods = stats.periods as JsonRecord;
    const value = periods[period] as JsonRecord;
    value.totalTokens = totalTokens;
    value.costUsd = costUsd;
}

function freshnessAt(stats: JsonRecord, updatedAt: string): JsonRecord {
    return {
        updatedAt,
        staleAfterMs: stats.staleAfterMs,
        devices: (stats.devices as JsonRecord[]).map(device => ({
            deviceId: device.deviceId,
            updatedAt,
            receivedAt: updatedAt,
            ageMs: 0,
            stale: false,
        })),
    };
}

function sendStats(hub: ControlledHub, event: 'snapshot' | 'stats', stats: JsonRecord): void {
    hub.send(event, { type: 'stats', reason: event, stats, at: stats.updatedAt });
}

function sendFreshness(hub: ControlledHub, stats: JsonRecord): void {
    hub.send('freshness', { type: 'freshness', reason: 'heartbeat', stats, at: stats.updatedAt });
}

async function waitForConnections(hubs: ControlledHub[], counts: number[]): Promise<void> {
    await expect.poll(() => hubs.map(hub => hub.activeConnections)).toEqual(counts);
}

function streamUrl(baseUrl: string): string {
    return new URL('/api/usage/stream', baseUrl).toString();
}

function readOverview(path: string): UsageOverview {
    return withDatabase(path, db => {
        const rows = db.prepare(`
            SELECT h.hub_id, h.name, s.stats_json, s.received_at
            FROM hubs h LEFT JOIN hub_states s ON s.hub_id = h.hub_id
            ORDER BY h.hub_id
        `).all() as Array<{ hub_id: string; name: string; stats_json: string | null; received_at: string | null }>;
        return { hubs: rows.map(row => {
            if (row.stats_json === null || row.received_at === null)
                return { hubId: row.hub_id, name: row.name, state: null };
            const stats = JSON.parse(row.stats_json) as JsonRecord;
            const periods = stats.periods as JsonRecord;
            const historyPreview = stats.historyPreview as JsonRecord | undefined;
            const historySummary = historyPreview?.summary as JsonRecord | undefined;
            const activeDays = typeof historySummary?.activeDays === 'number' ? historySummary.activeDays : undefined;
            return {
                hubId: row.hub_id,
                name: row.name,
                state: {
                    updatedAt: stats.updatedAt as string,
                    receivedAt: row.received_at,
                    ...(activeDays !== undefined ? { activeDays } : {}),
                    periods: {
                        today: periodOf(periods.today),
                        month: periodOf(periods.month),
                        total: periodOf(periods.allTime),
                    },
                    devices: (stats.devices as JsonRecord[]).map(device => ({
                        deviceId: device.deviceId as string,
                        hostname: device.hostname as string,
                        platform: device.platform as string,
                        updatedAt: device.updatedAt as string,
                        stale: device.stale as boolean,
                    })),
                },
            } satisfies HubUsageOverview;
        }) };
    });
}

function periodOf(value: unknown): { totalTokens: number; costUsd: number } {
    const period = value as JsonRecord;
    return { totalTokens: period.totalTokens as number, costUsd: period.costUsd as number };
}

function readRawStats(path: string, hubId: string): JsonRecord | undefined {
    return readStoredState(path, hubId)?.stats;
}

function readStoredState(path: string, hubId: string): { stats: JsonRecord; receivedAt: string } | undefined {
    return withDatabase(path, db => {
        const row = db.prepare('SELECT stats_json, received_at FROM hub_states WHERE hub_id = ?').get(hubId) as
            | { stats_json: string; received_at: string }
            | undefined;
        return row ? { stats: JSON.parse(row.stats_json) as JsonRecord, receivedAt: row.received_at } : undefined;
    });
}

function databaseText(path: string): string {
    return withDatabase(path, db => JSON.stringify(db.prepare(`
        SELECT h.hub_id, h.name, s.stats_json, s.received_at
        FROM hubs h LEFT JOIN hub_states s ON s.hub_id = h.hub_id
        ORDER BY h.hub_id
    `).all()));
}

function installSaveFailure(path: string, hubId: string): void {
    const db = new DatabaseSync(path);
    try {
        db.exec(`
            CREATE TRIGGER e2e_fail_save
            BEFORE INSERT ON hub_states
            WHEN NEW.hub_id = '${hubId}'
            BEGIN
                SELECT RAISE(ABORT, 'e2e save failure');
            END;
        `);
    }
    finally {
        db.close();
    }
}

function corruptState(path: string, hubId: string): void {
    const db = new DatabaseSync(path);
    try {
        db.prepare('UPDATE hub_states SET stats_json = ? WHERE hub_id = ?').run('{}', hubId);
    }
    finally {
        db.close();
    }
}

function withDatabase<T>(path: string, operation: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        return operation(db);
    }
    finally {
        db.close();
    }
}
