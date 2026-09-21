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

test('登録Hubだけを表示し、未受信状態から保存値を自動反映する', async ({ app, hubs, page }) => {
    seedRemovedHub(app.databasePath);
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Hub・デバイス' })).toBeVisible();
    const hubPanel = page.getByRole('region', { name: 'Hub・デバイス' });
    await expect(hubPanel.getByText('まだ情報を受信していません')).toHaveCount(2);
    await expect(page.getByRole('region', { name: '利用枠' }).getByText('まだ情報を受信していません')).toBeVisible();
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

    // 保存後通知を受けた時点で、再読込なしに画面を更新する。
    await expect(page.getByRole('article', { name: 'Hub A' })).toContainText('1,234,567');
    await expect(page.getByRole('article', { name: 'Hub A' })).toContainText('$12.34');
    await expect(hubPanel.getByText('まだ情報を受信していません')).toHaveCount(1);
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

test('保存通知で全期間の数値・料金・台数・構成比を全置換し、選択期間と共有接続を維持する', async ({ app, hubs, page }) => {
    const requests = trackUsageRequests(page);
    await waitForConnections(hubs, [1, 1]);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Hub・デバイス' })).toBeVisible();
    await expect.poll(() => requests.apiGets).toBe(1);
    await expect.poll(() => requests.streamGets).toBe(1);
    await expect.poll(() => requests.streamStatuses.filter(status => status === 200).length).toBe(1);

    const initialA = dashboardStats('2026-09-21T01:10:00.000Z');
    const initialB = dashboardStats('2026-09-21T01:11:00.000Z');
    setDashboardValues(initialA, {
        today: { tokens: 1_000_000, costUsd: 10 },
        month: { tokens: 3_000_000, costUsd: 30 },
        allTime: { tokens: 4_000_000, costUsd: 40 },
    }, 1);
    setDashboardValues(initialB, {
        today: { tokens: 2_000_000, costUsd: 20 },
        month: { tokens: 1_000_000, costUsd: 10 },
        allTime: { tokens: 6_000_000, costUsd: 60 },
    }, 2);
    sendStats(hubs[0], 'snapshot', initialA);
    sendStats(hubs[1], 'snapshot', initialB);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a', 'month')).toBe(3_000_000);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-b', 'month')).toBe(1_000_000);

    const hubPanel = page.getByRole('region', { name: 'Hub・デバイス' });
    await expect(page.getByRole('button', { name: 'MONTH' })).toHaveAttribute('aria-pressed', 'true');
    await expectPeriod(page, hubPanel, 'TODAY', {
        totalTokens: '3,000,000',
        totalCost: '$30.00',
        hubA: { tokens: '1,000,000', cost: '$10.00', tokenShare: '33.3%', costShare: '33.3%' },
        hubB: { tokens: '2,000,000', cost: '$20.00', tokenShare: '66.7%', costShare: '66.7%' },
    });
    await expectPeriod(page, hubPanel, 'MONTH', {
        totalTokens: '4,000,000',
        totalCost: '$40.00',
        hubA: { tokens: '3,000,000', cost: '$30.00', tokenShare: '75.0%', costShare: '75.0%' },
        hubB: { tokens: '1,000,000', cost: '$10.00', tokenShare: '25.0%', costShare: '25.0%' },
    });
    await expectPeriod(page, hubPanel, 'TOTAL', {
        totalTokens: '10,000,000',
        totalCost: '$100.00',
        hubA: { tokens: '4,000,000', cost: '$40.00', tokenShare: '40.0%', costShare: '40.0%' },
        hubB: { tokens: '6,000,000', cost: '$60.00', tokenShare: '60.0%', costShare: '60.0%' },
    });
    await expect(page.getByText('受信済み 2 / 登録 2 Hub')).toBeVisible();
    await expect(page.getByText('デバイス 3 台')).toBeVisible();

    // 同じ使用量を再受信しても加算しない。台数の変化で通知の画面反映を待つ。
    const duplicateA = dashboardStats('2026-09-21T01:12:00.000Z');
    setDashboardValues(duplicateA, {
        today: { tokens: 1_000_000, costUsd: 10 },
        month: { tokens: 3_000_000, costUsd: 30 },
        allTime: { tokens: 4_000_000, costUsd: 40 },
    }, 2);
    sendStats(hubs[0], 'stats', duplicateA);
    await expect.poll(() => readUpdatedAt(app.databasePath, 'hub-a')).toBe(duplicateA.updatedAt);
    await expect(page.getByRole('button', { name: 'TOTAL' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('デバイス 4 台')).toBeVisible();
    await expect(hubPanel.getByText('10,000,000', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'TODAY' }).click();
    const todayA = dashboardStats('2026-09-21T01:20:00.000Z');
    const todayB = dashboardStats('2026-09-21T01:21:00.000Z');
    setDashboardValues(todayA, {
        today: { tokens: 9_000_000, costUsd: 90 },
        month: { tokens: 8_000_000, costUsd: 80 },
        allTime: { tokens: 5_000_000, costUsd: 50 },
    }, 2);
    setDashboardValues(todayB, {
        today: { tokens: 1_000_000, costUsd: 10 },
        month: { tokens: 2_000_000, costUsd: 20 },
        allTime: { tokens: 5_000_000, costUsd: 50 },
    }, 0);
    sendStats(hubs[0], 'stats', todayA);
    sendStats(hubs[1], 'stats', todayB);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a', 'today')).toBe(9_000_000);
    await expect(hubPanel.getByRole('article', { name: 'Hub A' })).toContainText('9,000,000');
    await expect(page.getByRole('button', { name: 'TODAY' })).toHaveAttribute('aria-pressed', 'true');
    await expectPeriod(page, hubPanel, 'TODAY', {
        totalTokens: '10,000,000',
        totalCost: '$100.00',
        hubA: { tokens: '9,000,000', cost: '$90.00', tokenShare: '90.0%', costShare: '90.0%' },
        hubB: { tokens: '1,000,000', cost: '$10.00', tokenShare: '10.0%', costShare: '10.0%' },
    });
    await expect(page.getByRole('button', { name: 'TODAY' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('デバイス 2 台')).toBeVisible();

    await page.getByRole('button', { name: 'MONTH' }).click();
    const monthA = dashboardStats('2026-09-21T01:30:00.000Z');
    const monthB = dashboardStats('2026-09-21T01:31:00.000Z');
    setDashboardValues(monthA, {
        today: { tokens: 2_000_000, costUsd: 20 },
        month: { tokens: 7_000_000, costUsd: 70 },
        allTime: { tokens: 9_000_000, costUsd: 90 },
    }, 0);
    setDashboardValues(monthB, {
        today: { tokens: 3_000_000, costUsd: 30 },
        month: { tokens: 3_000_000, costUsd: 30 },
        allTime: { tokens: 1_000_000, costUsd: 10 },
    }, 1);
    sendStats(hubs[0], 'stats', monthA);
    sendStats(hubs[1], 'stats', monthB);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a', 'month')).toBe(7_000_000);
    await expect(hubPanel.getByRole('article', { name: 'Hub A' })).toContainText('7,000,000');
    await expect(page.getByRole('button', { name: 'MONTH' })).toHaveAttribute('aria-pressed', 'true');
    await expectPeriod(page, hubPanel, 'MONTH', {
        totalTokens: '10,000,000',
        totalCost: '$100.00',
        hubA: { tokens: '7,000,000', cost: '$70.00', tokenShare: '70.0%', costShare: '70.0%' },
        hubB: { tokens: '3,000,000', cost: '$30.00', tokenShare: '30.0%', costShare: '30.0%' },
    });
    await expect(page.getByRole('button', { name: 'MONTH' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('デバイス 1 台')).toBeVisible();

    await page.getByRole('button', { name: 'TOTAL' }).click();
    const totalA = dashboardStats('2026-09-21T01:40:00.000Z');
    const totalB = dashboardStats('2026-09-21T01:41:00.000Z');
    setDashboardValues(totalA, {
        today: { tokens: 4_000_000, costUsd: 40 },
        month: { tokens: 1_000_000, costUsd: 10 },
        allTime: { tokens: 8_000_000, costUsd: 80 },
    }, 1);
    setDashboardValues(totalB, {
        today: { tokens: 6_000_000, costUsd: 60 },
        month: { tokens: 9_000_000, costUsd: 90 },
        allTime: { tokens: 2_000_000, costUsd: 20 },
    }, 2);
    sendStats(hubs[0], 'stats', totalA);
    sendStats(hubs[1], 'stats', totalB);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a', 'allTime')).toBe(8_000_000);
    await expect(hubPanel.getByRole('article', { name: 'Hub A' })).toContainText('8,000,000');
    await expect(page.getByRole('button', { name: 'TOTAL' })).toHaveAttribute('aria-pressed', 'true');
    await expectPeriod(page, hubPanel, 'TOTAL', {
        totalTokens: '10,000,000',
        totalCost: '$100.00',
        hubA: { tokens: '8,000,000', cost: '$80.00', tokenShare: '80.0%', costShare: '80.0%' },
        hubB: { tokens: '2,000,000', cost: '$20.00', tokenShare: '20.0%', costShare: '20.0%' },
    });
    await expect(page.getByRole('button', { name: 'TOTAL' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('デバイス 3 台')).toBeVisible();
    expect(requests.apiGets).toBe(1);
    expect(requests.streamGets).toBe(1);
});

test('初回APIの古い応答を保持中に保存された値を接続時通知で反映する', async ({ app, hubs, page }) => {
    const requests = trackUsageRequests(page);
    let releaseResponse: (() => void) | undefined;
    let resolveResponseHeld!: () => void;
    const responseHeld = new Promise<void>(resolve => { resolveResponseHeld = resolve; });
    await page.route('**/api/trpc/usageOverview*', async (route) => {
        const response = await route.fetch();
        const body = await response.body();
        resolveResponseHeld();
        await new Promise<void>(resolve => { releaseResponse = resolve; });
        await route.fulfill({ response, body });
    });

    await waitForConnections(hubs, [1, 1]);
    try {
        const navigation = page.goto('/');
        await responseHeld;
        await expect.poll(() => requests.apiGets).toBe(1);

        const latest = dashboardStats('2026-09-21T02:10:00.000Z');
        setDashboardValues(latest, {
            today: { tokens: 6_543_210, costUsd: 65.43 },
            month: { tokens: 7_654_321, costUsd: 76.54 },
            allTime: { tokens: 8_765_432, costUsd: 87.65 },
        }, 2);
        sendStats(hubs[0], 'snapshot', latest);
        await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a', 'month')).toBe(7_654_321);
        expect(requests.streamGets).toBe(0);

        releaseResponse?.();
        await navigation;
        const hubA = page.getByRole('article', { name: 'Hub A' });
        await expect(hubA).toContainText('7,654,321');
        await expect(hubA).toContainText('$76.54');
        await expect(page.getByText('受信済み 1 / 登録 2 Hub')).toBeVisible();
        await expect.poll(() => requests.streamGets).toBe(1);
        await expect.poll(() => requests.streamStatuses.filter(status => status === 200).length).toBe(1);
    }
    finally {
        releaseResponse?.();
        await page.unroute('**/api/trpc/usageOverview*');
    }
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

test('保存値を自動更新し、再読込時にも最新値を取得する', async ({ app, hubs, page }) => {
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
    await expect(hubA).toContainText('9,999,999');
    expect(apiCalls).toBe(1);

    await page.reload();
    await expect(hubA).toContainText('9,999,999');
    await expect.poll(() => apiCalls).toBe(2);
});

test('利用状況APIの失敗時はHub欄へエラーを表示し保存済み状態を変更しない', async ({ app, hubs, page }) => {
    const requests = trackUsageRequests(page);
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
    await expect(page.getByText('利用枠を取得できませんでした')).toBeVisible();
    expect(databaseText(app.databasePath)).toBe(before);
    await expect.poll(() => requests.apiGets).toBe(1);
    expect(requests.streamGets).toBe(0);
    await expect.poll(() => hubs.map((hub) => hub.activeConnections)).toEqual([1, 1]);
});

test('通知の読み取り失敗では保存値を保持して503を再試行し、DB復旧後に最新値へ追いつく', async ({ app, hubs, page }) => {
    const requests = trackUsageRequests(page);
    await waitForConnections(hubs, [1, 1]);

    const initialA = dashboardStats('2026-09-21T06:00:00.000Z');
    const initialB = dashboardStats('2026-09-21T06:01:00.000Z');
    setDashboardValues(initialA, {
        today: { tokens: 1_100_000, costUsd: 11 },
        month: { tokens: 2_200_000, costUsd: 22 },
        allTime: { tokens: 3_300_000, costUsd: 33 },
    }, 1);
    setDashboardValues(initialB, {
        today: { tokens: 4_400_000, costUsd: 44 },
        month: { tokens: 5_500_000, costUsd: 55 },
        allTime: { tokens: 6_600_000, costUsd: 66 },
    }, 1);
    sendStats(hubs[0], 'snapshot', initialA);
    sendStats(hubs[1], 'snapshot', initialB);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a', 'month')).toBe(2_200_000);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-b', 'month')).toBe(5_500_000);

    await page.goto('/');
    await page.getByRole('button', { name: 'TOTAL' }).click();
    await expect(page.getByRole('button', { name: 'TOTAL' })).toHaveAttribute('aria-pressed', 'true');
    const hubA = page.getByRole('article', { name: 'Hub A' });
    await expect(hubA).toContainText('3,300,000');
    await expect.poll(() => requests.streamStatuses.filter(status => status === 200).length).toBe(1);

    let hubsUnavailable = false;
    try {
        renameHubTable(app.databasePath);
        hubsUnavailable = true;

        const savedDuringFailure = dashboardStats('2026-09-21T06:02:00.000Z');
        setDashboardValues(savedDuringFailure, {
            today: { tokens: 7_700_000, costUsd: 77 },
            month: { tokens: 8_800_000, costUsd: 88 },
            allTime: { tokens: 9_900_000, costUsd: 99 },
        }, 2);
        sendStats(hubs[0], 'stats', savedDuringFailure);
        await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a', 'month')).toBe(8_800_000);
        await expect(page.getByRole('status')).toHaveText('再接続中');
        await expect.poll(
            () => requests.streamStatuses.filter(status => status === 503).length,
            { timeout: 15_000 },
        ).toBeGreaterThanOrEqual(2);
        await expect(page.getByRole('button', { name: 'TOTAL' })).toHaveAttribute('aria-pressed', 'true');
        await expect(hubA).toContainText('3,300,000');
        await expect(hubA).not.toContainText('9,900,000');

        restoreHubTable(app.databasePath);
        hubsUnavailable = false;
        const latest = dashboardStats('2026-09-21T06:03:00.000Z');
        setDashboardValues(latest, {
            today: { tokens: 12_100_000, costUsd: 121 },
            month: { tokens: 13_200_000, costUsd: 132 },
            allTime: { tokens: 14_300_000, costUsd: 143 },
        }, 2);
        sendStats(hubs[0], 'stats', latest);
        await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a', 'month')).toBe(13_200_000);
        await expect.poll(
            () => requests.streamStatuses.filter(status => status === 200).length,
            { timeout: 12_000 },
        ).toBeGreaterThanOrEqual(2);
        await expect(page.getByRole('button', { name: 'TOTAL' })).toHaveAttribute('aria-pressed', 'true');
        await expect(hubA).toContainText('14,300,000');
        await expect(hubA).toContainText('$143.00');
        await expect(page.getByRole('status')).toHaveCount(0);
        expect(requests.apiGets).toBe(1);
        expect(requests.streamGets).toBeGreaterThanOrEqual(4);
    }
    finally {
        if (hubsUnavailable)
            restoreHubTable(app.databasePath);
    }
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

test('全Hub統合情報を画面上部の主要指標に反映し、期間切替・通知更新・ヘッダー日時・バッジ整理を検証する', async ({ app, hubs, page }) => {
    // 1. 未受信状態の確認
    await page.goto('/');
    const mainStats = page.getByRole('region', { name: '主要指標' });
    const kpiCards = mainStats.locator('> div');

    await expect(kpiCards.nth(0).locator('strong')).toHaveText('0');
    await expect(kpiCards.nth(0).locator('small')).toHaveText('全Hub合計');
    await expect(kpiCards.nth(1).locator('strong')).toHaveText('$0.00');
    await expect(kpiCards.nth(1).locator('small')).toHaveText('USD 換算');
    await expect(kpiCards.nth(2).locator('strong')).toHaveText('0');
    await expect(kpiCards.nth(2).locator('small')).toHaveText('受信Hubの最大値');
    await expect(kpiCards.nth(3).locator('strong')).toHaveText('0');
    await expect(kpiCards.nth(3).locator('small')).toHaveText('受信済み 0 Hub');

    // ラベル確認: 保存値ラベルは0件、固定サンプルラベルは未更新パーツ（トレンド）のみ
    const badges = page.locator('.mantine-Badge-root');
    await expect(badges).toHaveText(['固定サンプル']);

    // 2. Hub-A と Hub-B からデータ受信
    await waitForConnections(hubs, [1, 1]);
    const statsA = dashboardStats('2026-09-21T01:00:00.000Z');
    const statsB = dashboardStats('2026-09-21T01:01:00.000Z');
    setPeriod(statsA, 'today', 42_621_015, 29.89);
    setPeriod(statsB, 'today', 8_729_605, 6.12);
    setPeriod(statsA, 'month', 3_862_063_575, 1561.13);
    setPeriod(statsB, 'month', 791_025_069, 319.75);
    setPeriod(statsA, 'allTime', 24_419_264_000, 9869.05);
    setPeriod(statsB, 'allTime', 5_001_536_000, 2021.37);
    setActiveDays(statsA, 15);
    setActiveDays(statsB, 28);
    sendStats(hubs[0], 'snapshot', statsA);
    sendStats(hubs[1], 'snapshot', statsB);

    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a', 'month')).toBe(3_862_063_575);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-b', 'month')).toBe(791_025_069);

    // 3. 自動更新により主要指標が反映される（初期表示 MONTH）
    await expect(kpiCards.nth(0).locator('strong')).toHaveText('4,653,088,644');
    await expect(kpiCards.nth(1).locator('strong')).toHaveText('$1,880.88');
    await expect(kpiCards.nth(2).locator('strong')).toHaveText('28');
    await expect(kpiCards.nth(3).locator('strong')).toHaveText('4');
    await expect(kpiCards.nth(3).locator('small')).toHaveText('受信済み 2 Hub');

    // 最上段ヘッダーに期間と更新時刻が表示されている（TODAY の左側）
    const headerControls = page.locator('[class*="headerControls"]');
    await expect(headerControls).toContainText('取得');
    await expect(headerControls).toContainText('TODAY');

    // 4. 期間切替 (TODAY)
    await page.getByRole('button', { name: 'TODAY' }).click();
    await expect(kpiCards.nth(0).locator('strong')).toHaveText('51,350,620');
    await expect(kpiCards.nth(1).locator('strong')).toHaveText('$36.01');
    await expect(kpiCards.nth(2).locator('strong')).toHaveText('28');

    // 5. 期間切替 (TOTAL)
    await page.getByRole('button', { name: 'TOTAL' }).click();
    await expect(kpiCards.nth(0).locator('strong')).toHaveText('29,420,800,000');
    await expect(kpiCards.nth(1).locator('strong')).toHaveText('$11,890.42');
    await expect(kpiCards.nth(2).locator('strong')).toHaveText('28');

    // 6. 単一Hub更新通知で再読み込みなしに主要指標が即時更新される
    const updatedA = dashboardStats('2026-09-21T01:05:00.000Z');
    setPeriod(updatedA, 'allTime', 25_000_000_000, 10000.00);
    setActiveDays(updatedA, 35);
    sendStats(hubs[0], 'stats', updatedA);

    await expect(kpiCards.nth(0).locator('strong')).toHaveText('30,001,536,000');
    await expect(kpiCards.nth(1).locator('strong')).toHaveText('$12,021.37');
    await expect(kpiCards.nth(2).locator('strong')).toHaveText('35');
});

test('保存済み利用枠をアカウント単位で表示し、期間切替と残量変化の並びを反映する', async ({ app, hubs, page }) => {
    await waitForConnections(hubs, [1, 1]);
    const stats = dashboardStats('2026-09-21T08:00:00.000Z');
    setHubLimits(stats, [
        limitProvider({
            provider: 'codex',
            accountKey: 'codex-plus',
            accountLabel: 'Plus',
            accountEmail: 'plus@example.test',
            updatedAt: '2026-09-21T08:00:00.000Z',
            windows: [
                limitWindow({ kind: 'weekly', remainingPercent: 24, windowMinutes: 10080, resetsAt: '2026-12-01T00:00:00.000Z' }),
                limitWindow({ kind: 'session', remainingPercent: 99, windowMinutes: 300, resetsAt: '2026-12-01T00:00:00.000Z' }),
            ],
        }),
        limitProvider({
            provider: 'cursor',
            accountKey: 'cursor-pro',
            planLabel: 'Pro',
            updatedAt: '2026-09-21T09:00:00.000Z',
            windows: [
                limitWindow({ kind: 'billing', label: 'Cursor Models', remainingPercent: 15.4, windowMinutes: null, resetsAt: '2026-01-01T00:00:00.000Z' }),
                limitWindow({ kind: 'weekly', label: 'Grok Bot', remainingPercent: 100, windowMinutes: null, resetsAt: null, showMeter: true }),
                limitWindow({ kind: 'billing', label: 'Hidden', remainingPercent: 50, showMeter: false }),
            ],
        }),
        limitProvider({
            provider: 'codex',
            accountKey: 'codex-pro',
            accountLabel: 'Pro 5x',
            updatedAt: '2026-09-21T07:00:00.000Z',
            windows: [
                limitWindow({ kind: 'weekly', remainingPercent: 8, windowMinutes: 10080, resetsAt: '2026-12-01T00:00:00.000Z' }),
            ],
        }),
        limitProvider({
            provider: 'claude',
            accountKey: '',
            status: 'notConfigured',
            updatedAt: '2026-09-21T10:00:00.000Z',
            windows: [],
        }),
    ]);
    sendStats(hubs[0], 'snapshot', stats);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a')).toBe(
        ((stats.periods as JsonRecord).today as JsonRecord).totalTokens,
    );

    await page.goto('/');
    const limits = page.getByRole('region', { name: '利用枠' });
    await expect(limits.getByText('固定サンプル')).toHaveCount(0);
    await expect(limits.getByText('Hidden')).toHaveCount(0);
    await expect(limits.getByText('Claude')).toHaveCount(0);
    await expect(page.getByText('plus@example.test')).toHaveCount(0);

    await expect(limits.locator('[class*="limitAccountName"]')).toHaveText(['Cursor', 'Codex Plus', 'Codex Pro 5x']);
    await expect(limits.getByLabel('Codex Plus', { exact: true }).locator('[class*="limitLabel"] strong')).toHaveText(['Session', 'Weekly']);
    await expect(limits.getByLabel('Cursor', { exact: true }).locator('[class*="limitLabel"] strong')).toHaveText(['Grok Bot', 'Cursor Models']);
    await expect(limits.getByLabel('Codex Plus、Sessionの残量')).toBeVisible();
    await expect(limits.getByText('99% 残り')).toBeVisible();
    await expect(limits.getByText('15% 残り')).toBeVisible();
    await expect(limits.getByText('8% 残り')).toBeVisible();
    await expect(limits.getByText('リセット予定を過ぎています')).toBeVisible();
    await expect(limits.getByLabel('Cursor', { exact: true }).getByText('リセットまで')).toHaveCount(0);

    const remainingBefore = await limits.locator('[class*="limitRemaining"]').allTextContents();
    await page.getByRole('button', { name: 'TODAY' }).click();
    await expect(limits.locator('[class*="limitRemaining"]')).toHaveText(remainingBefore);

    const updated = dashboardStats('2026-09-21T08:10:00.000Z');
    setHubLimits(updated, [
        limitProvider({
            provider: 'codex',
            accountKey: 'codex-plus',
            accountLabel: 'Plus',
            updatedAt: '2026-09-21T08:00:00.000Z',
            windows: [
                limitWindow({ kind: 'weekly', remainingPercent: 24, windowMinutes: 10080, resetsAt: '2026-12-01T00:00:00.000Z' }),
                limitWindow({ kind: 'session', remainingPercent: 99, windowMinutes: 300, resetsAt: '2026-12-01T00:00:00.000Z' }),
            ],
        }),
        limitProvider({
            provider: 'cursor',
            accountKey: 'cursor-pro',
            planLabel: 'Pro',
            updatedAt: '2026-09-21T09:00:00.000Z',
            windows: [
                limitWindow({ kind: 'billing', label: 'Cursor Models', remainingPercent: 15.4, windowMinutes: null, resetsAt: '2026-01-01T00:00:00.000Z' }),
                limitWindow({ kind: 'weekly', label: 'Grok Bot', remainingPercent: 100, windowMinutes: null, resetsAt: null }),
            ],
        }),
        limitProvider({
            provider: 'codex',
            accountKey: 'codex-pro',
            accountLabel: 'Pro 5x',
            updatedAt: '2026-09-21T10:00:00.000Z',
            windows: [
                limitWindow({ kind: 'weekly', remainingPercent: 7, windowMinutes: 10080, resetsAt: '2026-12-01T00:00:00.000Z' }),
            ],
        }),
    ]);
    sendStats(hubs[0], 'stats', updated);
    await expect(limits.getByText('7% 残り')).toBeVisible();
    await expect(limits.locator('[class*="limitAccountName"]')).toHaveText(['Codex Pro 5x', 'Cursor', 'Codex Plus']);
});

test('同一利用枠は複数Hubで1行にまとめ、表示対象が無い場合と秘密非公開を守る', async ({ app, hubs, page }) => {
    await waitForConnections(hubs, [1, 1]);
    const statsA = dashboardStats('2026-09-21T08:20:00.000Z');
    const statsB = dashboardStats('2026-09-21T08:21:00.000Z');
    setHubLimits(statsA, [
        limitProvider({
            provider: 'codex',
            accountKey: 'codex-plus',
            accountLabel: 'Plus',
            accountEmail: 'plus@example.test',
            updatedAt: '2026-09-21T08:00:00.000Z',
            windows: [
                limitWindow({ kind: 'weekly', remainingPercent: 40, windowMinutes: 10080, resetsAt: '2026-12-01T00:00:00.000Z' }),
            ],
        }),
    ]);
    setHubLimits(statsB, [
        limitProvider({
            provider: 'codex',
            accountKey: 'codex-plus',
            accountLabel: 'Plus',
            accountEmail: 'plus@example.test',
            updatedAt: '2026-09-21T09:00:00.000Z',
            windows: [
                limitWindow({ kind: 'weekly', remainingPercent: 24, windowMinutes: 10080, resetsAt: '2026-12-01T00:00:00.000Z' }),
            ],
        }),
    ]);
    sendStats(hubs[0], 'snapshot', statsA);
    sendStats(hubs[1], 'snapshot', statsB);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-b')).toBe(
        ((statsB.periods as JsonRecord).today as JsonRecord).totalTokens,
    );

    const responsePromise = page.waitForResponse((response) => (
        response.request().method() === 'GET'
        && response.url().includes('/api/trpc/usageOverview')
    ));
    await page.goto('/');
    const body = await (await responsePromise).text();
    expect(body).not.toContain('plus@example.test');
    expect(body).not.toContain('accountEmail');
    const limits = page.getByRole('region', { name: '利用枠' });
    await expect(limits.getByLabel('Codex', { exact: true })).toHaveCount(1);
    await expect(limits.getByText('24% 残り')).toBeVisible();
    await expect(limits.getByText('40% 残り')).toHaveCount(0);
    await expect(page.getByText('plus@example.test')).toHaveCount(0);

    const empty = dashboardStats('2026-09-21T08:30:00.000Z');
    setHubLimits(empty, [
        limitProvider({
            provider: 'claude',
            accountKey: '',
            status: 'notConfigured',
            updatedAt: '2026-09-21T08:30:00.000Z',
            windows: [],
        }),
    ]);
    sendStats(hubs[0], 'stats', empty);
    sendStats(hubs[1], 'stats', empty);
    await expect(limits.getByText('表示できる利用枠はありません')).toBeVisible();
});

test('ツール別トークン構成比を全Hubで集計し、期間切替と通知更新へ追従する', async ({ app, hubs, page }) => {
    await page.goto('/');
    const panel = page.getByRole('region', { name: 'ツール' });
    await expect(panel.getByText('まだ情報を受信していません')).toBeVisible();
    await expect(panel.getByText('最も利用したツール')).toHaveCount(0);
    await expect(panel.getByText('固定サンプル')).toHaveCount(0);

    await waitForConnections(hubs, [1, 1]);
    const statsA = dashboardStats('2026-09-21T07:00:00.000Z');
    const statsB = dashboardStats('2026-09-21T07:01:00.000Z');
    setPeriod(statsA, 'today', 1_000, 1);
    setPeriod(statsB, 'today', 1_000, 1);
    setPeriod(statsA, 'month', 1_000, 1);
    setPeriod(statsB, 'month', 1_000, 1);
    setPeriod(statsA, 'allTime', 1_000, 1);
    setPeriod(statsB, 'allTime', 1_000, 1);
    setToolClients(statsA, 'today', { codex: 100, antigravity: 20, cursor: 5 });
    setToolClients(statsB, 'today', { codex: 200, antigravity: 30, cursor: 45 });
    setToolClients(statsA, 'month', { codex: 400, antigravity: 100, cursor: 50 });
    setToolClients(statsB, 'month', { codex: 100, antigravity: 300, cursor: 50 });
    setToolClients(statsA, 'allTime', { codex: 600, antigravity: 100 });
    setToolClients(statsB, 'allTime', { codex: 300, antigravity: 100, copilot: 200 });
    sendStats(hubs[0], 'snapshot', statsA);
    sendStats(hubs[1], 'snapshot', statsB);

    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a', 'month')).toBe(1_000);
    await expect(panel.locator('[class*="rankRow"]').nth(0)).toContainText('codex');
    await expect(panel.locator('[class*="rankRow"]').nth(0)).toContainText('500');
    await expect(panel.getByText('50%', { exact: true })).toHaveCount(1);
    await expect(panel.getByText('40%', { exact: true })).toHaveCount(1);
    await expect(panel.getByText('10%', { exact: true })).toHaveCount(1);

    await page.getByRole('button', { name: 'TODAY' }).click();
    await expect(panel.locator('[class*="rankRow"]').nth(0)).toContainText('codex');
    await expect(panel.locator('[class*="rankRow"]').nth(0)).toContainText('300');
    await expect(panel.getByText('75%', { exact: true })).toHaveCount(1);
    await expect(panel.getByText('12.5%', { exact: true })).toHaveCount(2);

    await page.getByRole('button', { name: 'TOTAL' }).click();
    await expect(panel.locator('[class*="rankRow"]').nth(0)).toContainText('codex');
    await expect(panel.locator('[class*="rankRow"]').nth(0)).toContainText('900');
    await expect(panel.locator('[class*="rankRow"]').nth(1)).toContainText('antigravity');
    await expect(panel.getByText('69.2%', { exact: true })).toHaveCount(1);
    await expect(panel.getByText('15.4%', { exact: true })).toHaveCount(2);

    // 選択中のTOTALを維持したまま、片方のHubの保存通知で再集計する。
    setToolClients(statsA, 'allTime', { codex: 100, cursor: 900 });
    sendStats(hubs[0], 'stats', statsA);
    await expect(panel.locator('[class*="rankRow"]').nth(0)).toContainText('cursor');
    await expect(panel.locator('[class*="rankRow"]').nth(0)).toContainText('900');
    await expect(panel.getByText('56.3%', { exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'TOTAL' })).toHaveAttribute('aria-pressed', 'true');
});

test('全Hub合算のモデル別トークン構成比を表示し、上位9件＋その他・期間切替・自動更新に連動する', async ({ app, hubs, page }) => {
    // 1. 未受信状態: 「固定サンプル」バッジはなく、「利用データがありません」が表示される
    await page.goto('/');
    const modelsPanel = page.getByRole('region', { name: 'モデル' });
    await expect(modelsPanel).toBeVisible();
    await expect(modelsPanel.getByText('固定サンプル')).toHaveCount(0);
    await expect(modelsPanel.getByText('利用データがありません')).toBeVisible();

    await waitForConnections(hubs, [1, 1]);

    // 2. Hub A, Hub B から snapshot 受信 (MONTH は合算11種、TODAY は合算4種)
    const statsA = dashboardStats('2026-09-21T01:00:00.000Z');
    const statsB = dashboardStats('2026-09-21T01:00:00.000Z');

    setPeriod(statsA, 'today', 37_000_000, 37.0);
    setPeriodModels(statsA, 'today', {
        'gpt-5.6-luna': 25_000_000,
        'gpt-5.6-sol': 12_000_000,
    });
    setPeriod(statsB, 'today', 13_000_000, 13.0);
    setPeriodModels(statsB, 'today', {
        'gemini-3.8-flash': 8_000_000,
        'gpt-6-astra': 5_000_000,
    });

    // MONTH: 合算 11 種類のモデル
    setPeriod(statsA, 'month', 3_600_000_000, 3600.0);
    setPeriodModels(statsA, 'month', {
        'gpt-5.6-luna': 1_800_000_000,
        'gpt-5.6-sol': 900_000_000,
        'gpt-6-astra': 500_000_000,
        'gemini-3.8-flash': 350_000_000,
        'claude-4-sonnet': 50_000_000,
    });
    setPeriod(statsB, 'month', 900_000_000, 900.0);
    setPeriodModels(statsB, 'month', {
        'gpt-5.6-luna': 200_000_000,
        'gpt-5.6-sol': 370_000_000,
        'claude-4-sonnet': 100_000_000,
        'claude-4-haiku': 80_000_000,
        'gpt-5.2': 50_000_000,
        'mistral-large': 40_000_000,
        'qwen-2.5-coder': 35_000_000,
        'deepseek-r1': 15_000_000,
        'llama-3.3-70b': 10_000_000,
    });

    sendStats(hubs[0], 'snapshot', statsA);
    sendStats(hubs[1], 'snapshot', statsB);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-a', 'month')).toBe(3_600_000_000);
    await expect.poll(() => readTotalTokens(app.databasePath, 'hub-b', 'month')).toBe(900_000_000);

    // 初期選択期間は MONTH (合計 4,500,000,000)
    // 上位9件:
    // 1. gpt-5.6-luna: 2,000,000,000 (44.4%)
    // 2. gpt-5.6-sol: 1,270,000,000 (28.2%)
    // 3. gpt-6-astra: 500,000,000 (11.1%)
    // 4. gemini-3.8-flash: 350,000,000 (7.8%)
    // 5. claude-4-sonnet: 150,000,000 (3.3%)
    // 6. claude-4-haiku: 80,000,000 (1.8%)
    // 7. gpt-5.2: 50,000,000 (1.1%)
    // 8. mistral-large: 40,000,000 (0.9%)
    // 9. qwen-2.5-coder: 35,000,000 (0.8%)
    // 10. その他: deepseek-r1(15M) + llama-3.3-70b(10M) = 25,000,000 (0.6%)
    await expect(modelsPanel.getByText('利用データがありません')).toHaveCount(0);
    await expect(modelsPanel.getByText('gpt-5.6-luna')).toBeVisible();
    await expect(modelsPanel.getByText('2,000,000,000')).toBeVisible();
    await expect(modelsPanel.getByText('44.4%')).toBeVisible();
    await expect(modelsPanel.getByText('その他')).toBeVisible();
    await expect(modelsPanel.getByText('25,000,000')).toBeVisible();
    await expect(modelsPanel.getByText('0.6%')).toBeVisible();
    await expect(modelsPanel.getByRole('progressbar', { name: 'その他の構成比' })).toBeVisible();

    // 3. TODAY に切り替え (全4種 <= 9種のため「その他」非表示)
    await page.getByRole('button', { name: 'TODAY' }).click();
    await expect(page.getByRole('button', { name: 'TODAY' })).toHaveAttribute('aria-pressed', 'true');
    await expect(modelsPanel.getByText('gpt-5.6-luna')).toBeVisible();
    await expect(modelsPanel.getByText('25,000,000')).toBeVisible();
    await expect(modelsPanel.getByText('50%')).toBeVisible();
    await expect(modelsPanel.getByText('その他')).toHaveCount(0);
    await expect(modelsPanel.getByRole('progressbar', { name: 'その他の構成比' })).toHaveCount(0);

    // 4. 自動更新通知で TODAY のモデル値が即座に更新される
    const updatedA = dashboardStats('2026-09-21T01:10:00.000Z');
    setPeriod(updatedA, 'today', 50_000_000, 50.0);
    setPeriodModels(updatedA, 'today', {
        'gpt-5.6-luna': 35_000_000,
        'gpt-5.6-sol': 15_000_000,
    });
    sendStats(hubs[0], 'stats', updatedA);

    // Hub A: luna 35M, sol 15M / Hub B: gemini 8M, astra 5M -> 合計 63M
    // luna: 35M / 63M = 55.6%
    await expect(modelsPanel.getByText('35,000,000')).toBeVisible();
    await expect(modelsPanel.getByText('55.6%')).toBeVisible();
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

type PeriodValues = { tokens: number; costUsd: number };
type DashboardValues = Record<DashboardPeriod, PeriodValues>;
type UsageRequests = { apiGets: number; streamGets: number; streamStatuses: number[] };

function dashboardStats(updatedAt: string): JsonRecord {
    const stats = structuredClone(sourceStats);
    stats.updatedAt = updatedAt;
    return stats;
}

function setHubLimits(stats: JsonRecord, providers: JsonRecord[]): void {
    stats.limits = { updatedAt: stats.updatedAt, providers };
}

function limitProvider(value: JsonRecord): JsonRecord {
    return {
        provider: 'codex',
        accountKey: '',
        accountLabel: '',
        planLabel: '',
        accountName: '',
        accountEmail: '',
        workspaceKind: '',
        status: 'ok',
        source: 'oauth',
        sourceDetail: '',
        updatedAt: '2026-09-21T08:00:00.000Z',
        windows: [],
        balanceUsd: null,
        balance: null,
        resetCredits: null,
        region: '',
        sourceDeviceId: 'device',
        stale: false,
        ...value,
    };
}

function limitWindow(value: JsonRecord): JsonRecord {
    return {
        kind: 'weekly',
        label: '',
        used: null,
        limit: null,
        remaining: null,
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: null,
        windowMinutes: 10080,
        resetDescription: '',
        detail: '',
        currency: null,
        showMeter: true,
        ...value,
    };
}

function setActiveDays(stats: JsonRecord, activeDays: number): void {
    const historyPreview = stats.historyPreview as JsonRecord;
    const summary = historyPreview.summary as JsonRecord;
    summary.activeDays = activeDays;
}

function setPeriod(stats: JsonRecord, period: DashboardPeriod, totalTokens: number, costUsd: number): void {
    const periods = stats.periods as JsonRecord;
    const value = periods[period] as JsonRecord;
    value.totalTokens = totalTokens;
    value.costUsd = costUsd;
}

function setToolClients(stats: JsonRecord, period: DashboardPeriod, clients: Record<string, number>): void {
    const periods = stats.periods as JsonRecord;
    const value = periods[period] as JsonRecord;
    value.clients = clients;
}

function setPeriodModels(stats: JsonRecord, period: DashboardPeriod, models: Record<string, number>): void {
    const periods = stats.periods as JsonRecord;
    const value = periods[period] as JsonRecord;
    value.models = models;
}

function setDashboardValues(stats: JsonRecord, values: DashboardValues, deviceCount: number): void {
    for (const period of ['today', 'month', 'allTime'] as const) {
        const value = values[period];
        setPeriod(stats, period, value.tokens, value.costUsd);
    }
    stats.devices = structuredClone((sourceStats.devices as unknown[]).slice(0, deviceCount));
}

function sendStats(hub: ControlledHub, event: 'snapshot' | 'stats', stats: JsonRecord): void {
    hub.send(event, { type: 'stats', reason: event, stats, at: stats.updatedAt });
}

async function waitForConnections(hubs: ControlledHub[], counts: number[]): Promise<void> {
    await expect.poll(() => hubs.map((hub) => hub.activeConnections)).toEqual(counts);
}

function trackUsageRequests(page: Page): UsageRequests {
    const requests: UsageRequests = { apiGets: 0, streamGets: 0, streamStatuses: [] };
    page.on('request', request => {
        if (request.method() !== 'GET')
            return;
        const pathname = new URL(request.url()).pathname;
        if (pathname === '/api/usage/stream')
            requests.streamGets += 1;
        if (pathname === '/api/trpc/usageOverview')
            requests.apiGets += 1;
    });
    page.on('response', response => {
        if (new URL(response.url()).pathname === '/api/usage/stream')
            requests.streamStatuses.push(response.status());
    });
    return requests;
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

function readUpdatedAt(path: string, hubId: string): unknown {
    return withDatabase(path, (db) => {
        const row = db.prepare('SELECT stats_json FROM hub_states WHERE hub_id = ?').get(hubId) as { stats_json: string } | undefined;
        if (!row)
            return undefined;
        return (JSON.parse(row.stats_json) as JsonRecord).updatedAt;
    });
}

function renameHubTable(path: string): void {
    const db = new DatabaseSync(path);
    try {
        db.exec('PRAGMA busy_timeout = 2000; ALTER TABLE hubs RENAME TO hubs_unavailable;');
    }
    finally {
        db.close();
    }
}

function restoreHubTable(path: string): void {
    const db = new DatabaseSync(path);
    try {
        db.exec('PRAGMA busy_timeout = 2000; ALTER TABLE hubs_unavailable RENAME TO hubs;');
    }
    finally {
        db.close();
    }
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
