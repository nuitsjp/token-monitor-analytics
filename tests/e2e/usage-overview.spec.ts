import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Locator, Page } from '@playwright/test';
import { test, expect, type ControlledHub } from './fixtures.ts';

type JsonRecord = Record<string, unknown>;
type DashboardPeriod = 'today' | 'month' | 'allTime';

const sourceStats = JSON.parse(readFileSync(
    resolve('docs/reference/hub-private/2026-09-12T01-57-13-988Z/stats.json'), 'utf8',
)) as JsonRecord;

test('登録Hubだけを表示し、未受信状態から保存値を再読込で表示する', async ({ app, hubs, page }) => {
    seedRemovedHub(app.databasePath);
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Hub・デバイス' })).toBeVisible();
    await expect(page.getByText('まだ情報を受信していません')).toHaveCount(2);
    await expect(page.getByRole('article', { name: 'Hub A' })).toBeVisible();
    await expect(page.getByRole('article', { name: 'Hub B' })).toBeVisible();
    await expect(page.getByText('Removed Hub')).toHaveCount(0);
    await expect(page.getByText('受信済み 0 / 登録 2 Hub')).toBeVisible();
    await expect(page.getByText('デバイス 0 台')).toBeVisible();

    await waitForConnections(hubs, [1, 1]);
    const statsA = dashboardStats('2026-09-21T00:00:00.000Z');
    setPeriod(statsA, 'month', 1_234_567, 12.34);
    sendStats(hubs[0], 'snapshot', statsA);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a', 'month')).toBe(1_234_567);

    // 保存値の受信だけでは画面を更新せず、再読込時に一度だけ取得する。
    await expect(page.getByText('まだ情報を受信していません')).toHaveCount(2);
    await page.reload();
    await expect(page.getByRole('article', { name: 'Hub A' })).toContainText('1,234,567');
    await expect(page.getByRole('article', { name: 'Hub A' })).toContainText('$12.34');
    await expect(page.getByText('まだ情報を受信していません')).toHaveCount(1);
    await expect(page.getByText('受信済み 1 / 登録 2 Hub')).toBeVisible();
    await expect(page.getByText('デバイス 2 台')).toBeVisible();
    await expect(page.getByText('Removed Hub')).toHaveCount(0);
});

test('期間別の保存値を整数・料金・構成比で表示する', async ({ app, hubs, page }) => {
    await waitForConnections(hubs, [1, 1]);
    const statsA = dashboardStats('2026-09-21T01:00:00.000Z');
    const statsB = dashboardStats('2026-09-21T01:01:00.000Z');
    setPeriod(statsA, 'today', 1_234_567, 12.34);
    setPeriod(statsB, 'today', 765_433, 7.66);
    setPeriod(statsA, 'month', 2_345_678, 23.45);
    setPeriod(statsB, 'month', 1_234_322, 11.55);
    setPeriod(statsA, 'allTime', 3_456_789, 34.56);
    setPeriod(statsB, 'allTime', 543_211, 5.44);
    sendStats(hubs[0], 'snapshot', statsA);
    sendStats(hubs[1], 'snapshot', statsB);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a', 'month')).toBe(2_345_678);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-b', 'month')).toBe(1_234_322);

    await page.goto('/');
    const hubPanel = page.getByRole('region', { name: 'Hub・デバイス' });
    await expect(hubPanel.getByRole('article', { name: 'Hub A' })).toBeVisible();
    await expectPeriod(page, hubPanel, 'MONTH', {
        totalTokens: '3,580,000',
        totalCost: '$35.00',
        hubA: { tokens: '2,345,678', cost: '$23.45', tokenShare: '65.5%', costShare: '67.0%' },
        hubB: { tokens: '1,234,322', cost: '$11.55', tokenShare: '34.5%', costShare: '33.0%' },
    });
    await expectPeriod(page, hubPanel, 'TODAY', {
        totalTokens: '2,000,000',
        totalCost: '$20.00',
        hubA: { tokens: '1,234,567', cost: '$12.34', tokenShare: '61.7%', costShare: '61.7%' },
        hubB: { tokens: '765,433', cost: '$7.66', tokenShare: '38.3%', costShare: '38.3%' },
    });
    await expectPeriod(page, hubPanel, 'TOTAL', {
        totalTokens: '4,000,000',
        totalCost: '$40.00',
        hubA: { tokens: '3,456,789', cost: '$34.56', tokenShare: '86.4%', costShare: '86.4%' },
        hubB: { tokens: '543,211', cost: '$5.44', tokenShare: '13.6%', costShare: '13.6%' },
    });
});

test('利用状況APIは秘密情報を返さず、閲覧でSQLiteを変更しない', async ({ app, hubs, page }) => {
    await waitForConnections(hubs, [1, 1]);
    const stats = dashboardStats('2026-09-21T02:00:00.000Z');
    sendStats(hubs[0], 'snapshot', stats);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a')).toBe(
        ((stats.periods as JsonRecord).today as JsonRecord).totalTokens,
    );
    const before = databaseText(app.databasePath);
    const responsePromise = page.waitForResponse((response) => (
        response.request().method() === 'GET'
        && response.url().includes('/api/trpc/usageOverview')
    ));
    await page.goto('/');
    const response = await responsePromise;
    const body = await response.text();
    expect(response.ok()).toBe(true);
    for (const hub of hubs) {
        expect(body).not.toContain(hub.token);
        expect(body).not.toContain(hub.origin);
    }
    expect(await page.content()).not.toContain(hubs[0].token);
    expect(await page.content()).not.toContain(hubs[0].origin);
    expect(databaseText(app.databasePath)).toBe(before);
});

test('保存値は自動更新せず、再読込時だけ最新値を取得する', async ({ app, hubs, page }) => {
    await waitForConnections(hubs, [1, 1]);
    const initial = dashboardStats('2026-09-21T03:00:00.000Z');
    setPeriod(initial, 'month', 1_111_111, 11.11);
    sendStats(hubs[0], 'snapshot', initial);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a', 'month')).toBe(1_111_111);

    let apiCalls = 0;
    await page.route('**/api/trpc/usageOverview*', async (route) => {
        apiCalls += 1;
        await route.continue();
    });
    await page.goto('/');
    const hubA = page.getByRole('article', { name: 'Hub A' });
    await expect(hubA).toContainText('1,111,111');
    await expect.poll(() => apiCalls).toBe(1);

    const updated = dashboardStats('2026-09-21T03:01:00.000Z');
    setPeriod(updated, 'month', 9_999_999, 99.99);
    sendStats(hubs[0], 'stats', updated);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a', 'month')).toBe(9_999_999);
    await page.waitForTimeout(300);
    expect(apiCalls).toBe(1);
    await expect(hubA).toContainText('1,111,111');
    await expect(hubA).not.toContainText('9,999,999');

    await page.reload();
    await expect(hubA).toContainText('9,999,999');
    await expect.poll(() => apiCalls).toBe(2);
});

test('利用状況APIの失敗時はHub欄へエラーを表示し保存済み状態を変更しない', async ({ app, hubs, page }) => {
    await waitForConnections(hubs, [1, 1]);
    const stats = dashboardStats('2026-09-21T04:00:00.000Z');
    sendStats(hubs[0], 'snapshot', stats);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a')).toBe(
        ((stats.periods as JsonRecord).today as JsonRecord).totalTokens,
    );
    const before = databaseText(app.databasePath);
    await page.route('**/api/trpc/usageOverview*', (route) => route.abort());
    await page.goto('/');
    await expect(page.getByText('Hub・デバイスを取得できませんでした')).toBeVisible();
    expect(databaseText(app.databasePath)).toBe(before);
    await expect.poll(() => hubs.map((hub) => hub.activeConnections)).toEqual([1, 1]);
});

test('受信済みの使用量とコストが0なら数値0と空の構成比を表示する', async ({ app, hubs, page }) => {
    await waitForConnections(hubs, [1, 1]);
    for (const hub of hubs) {
        const stats = dashboardStats('2026-09-21T05:00:00.000Z');
        setPeriod(stats, 'month', 0, 0);
        sendStats(hub, 'snapshot', stats);
    }
    await expect.poll(() => hubs.map(hub => readTotalTokens(app.databasePath, hub.id, 'month'))).toEqual([0, 0]);
    await page.goto('/');
    const panel = page.getByRole('region', { name: 'Hub・デバイス' });
    await expect(panel.getByText('0', { exact: true })).toHaveCount(3);
    await expect(panel.getByText('$0.00', { exact: true })).toHaveCount(3);
    await expect(panel.getByRole('group', { name: 'Hub別トークン使用量の内訳' }).locator('span')).toHaveCount(0);
    await expect(panel.getByRole('group', { name: 'Hub別推定コストの内訳' }).locator('span')).toHaveCount(0);
    await expect(panel.getByText('まだ情報を受信していません')).toHaveCount(0);
});

async function expectPeriod(
    page: Page,
    panel: Locator,
    period: 'TODAY' | 'MONTH' | 'TOTAL',
    expected: PeriodExpectation,
): Promise<void> {
    await page.getByRole('button', { name: period }).click();
    await expect(page.getByRole('button', { name: period })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByText(expected.totalTokens, { exact: true })).toBeVisible();
    await expect(panel.getByText(expected.totalCost, { exact: true })).toBeVisible();
    for (const [name, values] of [['Hub A', expected.hubA], ['Hub B', expected.hubB]] as const) {
        const row = panel.getByRole('article', { name });
        await expect(row.getByText(values.tokens, { exact: true })).toBeVisible();
        await expect(row.getByText(values.cost, { exact: true })).toBeVisible();
        const tokenGroup = panel.getByRole('group', { name: 'Hub別トークン使用量の内訳' });
        const costGroup = panel.getByRole('group', { name: 'Hub別推定コストの内訳' });
        await expect(tokenGroup.locator(`[aria-label="${name}: ${values.tokenShare}"]`)).toHaveCount(1);
        await expect(costGroup.locator(`[aria-label="${name}: ${values.costShare}"]`)).toHaveCount(1);
    }
}

type PeriodExpectation = {
    totalTokens: string;
    totalCost: string;
    hubA: HubExpectation;
    hubB: HubExpectation;
};

type HubExpectation = {
    tokens: string;
    cost: string;
    tokenShare: string;
    costShare: string;
};

function dashboardStats(updatedAt: string): JsonRecord {
    const stats = structuredClone(sourceStats);
    stats.updatedAt = updatedAt;
    return stats;
}

function setPeriod(stats: JsonRecord, period: DashboardPeriod, totalTokens: number, costUsd: number): void {
    const periods = stats.periods as JsonRecord;
    const value = periods[period] as JsonRecord;
    value.totalTokens = totalTokens;
    value.costUsd = costUsd;
}

function sendStats(hub: ControlledHub, event: 'snapshot' | 'stats', stats: JsonRecord): void {
    hub.send(event, { type: 'stats', reason: event, stats, at: stats.updatedAt });
}

async function waitForConnections(hubs: ControlledHub[], counts: number[]): Promise<void> {
    await expect.poll(() => hubs.map((hub) => hub.activeConnections)).toEqual(counts);
}

function seedRemovedHub(path: string): void {
    const db = new DatabaseSync(path);
    try {
        db.prepare('INSERT INTO hubs (hub_id, name) VALUES (?, ?)').run('hub-removed', 'Removed Hub');
        db.prepare(`
            INSERT INTO hub_states (hub_id, stats_json, received_at)
            VALUES (?, ?, ?)
        `).run('hub-removed', JSON.stringify(dashboardStats('2026-09-21T00:00:00.000Z')), '2026-09-21T00:00:00.000Z');
    }
    finally {
        db.close();
    }
}

function readTotalTokens(path: string, hubId: string, period: DashboardPeriod = 'today'): unknown {
    return withDatabase(path, (db) => {
        const row = db.prepare('SELECT stats_json FROM hub_states WHERE hub_id = ?').get(hubId) as { stats_json: string } | undefined;
        if (!row)
            return undefined;
        const stats = JSON.parse(row.stats_json) as JsonRecord;
        return ((stats.periods as JsonRecord)[period] as JsonRecord).totalTokens;
    });
}

function databaseText(path: string): string {
    return withDatabase(path, (db) => JSON.stringify(db.prepare(`
        SELECT h.hub_id, h.name, s.stats_json, s.received_at
        FROM hubs h LEFT JOIN hub_states s ON s.hub_id = h.hub_id
        ORDER BY h.hub_id
    `).all()));
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
