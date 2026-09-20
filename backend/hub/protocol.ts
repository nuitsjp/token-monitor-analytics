import { z } from 'zod';

const INVALID_NOTIFICATION = 'Hub通知が不正です。';

const finiteNumber = z.number().finite();
const numberMap = z.record(z.string(), finiteNumber);
const objectMap = z.record(z.string(), z.unknown());

const capabilitiesSchema = z.object({
    tokenComponents: z.boolean(),
    throughput: z.boolean(),
}).passthrough();

const projectSchema = z.object({
    label: z.string(),
    tokens: finiteNumber,
    costUsd: finiteNumber,
    clients: numberMap,
}).passthrough();

const sessionSchema = z.object({
    client: z.string(),
    sessionId: z.string(),
    totalTokens: finiteNumber,
    costUsd: finiteNumber,
    messageCount: finiteNumber,
    inputTokens: finiteNumber,
    outputTokens: finiteNumber,
    cacheReadTokens: finiteNumber,
    cacheWriteTokens: finiteNumber,
    reasoningTokens: finiteNumber,
    startedAt: z.string(),
    lastUsedAt: z.string(),
    projectId: z.string(),
    projectLabel: z.string(),
    title: z.string(),
    sessionKind: z.string(),
    models: numberMap,
    modelCosts: numberMap,
    providers: numberMap,
}).passthrough();

const periodSchema = z.object({
    capabilities: capabilitiesSchema,
    totalTokens: finiteNumber,
    costUsd: finiteNumber,
    cacheReadTokens: finiteNumber,
    cacheWriteTokens: finiteNumber,
    outputTokens: finiteNumber,
    unclassifiedTokens: finiteNumber,
    timedTokens: finiteNumber,
    timedOutputTokens: finiteNumber,
    timedDurationMs: finiteNumber,
    clients: numberMap,
    clientCosts: numberMap,
    clientCacheReads: numberMap,
    clientCacheWrites: numberMap,
    clientOutputs: numberMap,
    clientUnclassifiedTokens: numberMap,
    models: numberMap,
    modelCosts: numberMap,
    modelCacheReads: numberMap,
    modelCacheWrites: numberMap,
    modelOutputs: numberMap,
    modelUnclassifiedTokens: numberMap,
    clientModels: z.record(z.string(), numberMap),
    clientModelCosts: z.record(z.string(), numberMap),
    projects: z.record(z.string(), projectSchema),
    sessions: z.record(z.string(), sessionSchema),
}).passthrough();

const limitWindowSchema = z.object({
    kind: z.enum(['session', 'daily', 'weekly', 'billing']),
    used: finiteNumber.nullable(),
    limit: finiteNumber.nullable(),
    remaining: finiteNumber.nullable(),
    usedPercent: finiteNumber.nullable(),
    remainingPercent: finiteNumber.nullable(),
    resetsAt: z.string().nullable(),
    windowMinutes: finiteNumber.nullable(),
    resetDescription: z.string(),
    detail: z.string(),
    currency: z.string().nullable(),
    showMeter: z.boolean(),
}).extend({
    metric: z.enum(['credits', 'spend']).optional(),
    source: z.enum(['web', 'local']).optional(),
    limitId: z.string().optional(),
    boundaryKind: z.enum(['reset', 'expiry', 'mixed']).optional(),
    additional: z.boolean().optional(),
    label: z.string().optional(),
}).passthrough();

const limitProviderSchema = z.object({
    provider: z.string(),
    accountKey: z.string(),
    accountLabel: z.string(),
    planLabel: z.string(),
    accountName: z.string(),
    accountEmail: z.string(),
    workspaceKind: z.string(),
    status: z.string(),
    source: z.string(),
    sourceDetail: z.string(),
    updatedAt: z.string().nullable(),
    windows: z.array(limitWindowSchema),
    balanceUsd: finiteNumber.nullable(),
    balance: objectMap.nullable(),
    resetCredits: objectMap.nullable(),
    region: z.string(),
}).extend({
    sourceDeviceId: z.string().optional(),
    stale: z.boolean().optional(),
}).passthrough();

const limitsSchema = z.object({
    updatedAt: z.string(),
    providers: z.array(limitProviderSchema),
}).extend({
    refreshMs: finiteNumber.optional(),
}).passthrough();

const deviceSchema = z.object({
    deviceId: z.string(),
    hostname: z.string(),
    platform: z.string(),
    agentVersion: z.string(),
    agentRuntime: z.string(),
    updatedAt: z.string(),
    receivedAt: z.string(),
    ageMs: finiteNumber.nullable(),
    stale: z.boolean(),
    periods: z.object({
        today: periodSchema,
        month: periodSchema,
        allTime: periodSchema,
    }).passthrough(),
    limits: limitsSchema,
}).extend({
    osName: z.string().optional(),
    osVersion: z.string().optional(),
    trackedClients: z.array(z.string()).optional(),
    clientStatus: z.record(z.string(), z.string()).optional(),
    clientHealth: objectMap.nullable().optional(),
    wslStatus: objectMap.nullable().optional(),
    projectsEnabled: z.boolean().optional(),
    syncUploadIntervalMs: finiteNumber.optional(),
    periodWindows: objectMap.optional(),
    sessionDetailsOmitted: z.record(z.string(), finiteNumber).optional(),
    periodProjectsOmitted: z.record(z.string(), finiteNumber).optional(),
    allTimeProjectsOmitted: finiteNumber.optional(),
    allTimeProjectsIncomplete: z.boolean().optional(),
}).passthrough();

const historyDaySchema = z.object({
    date: z.string(),
    tokens: finiteNumber,
    cost: finiteNumber,
    activeTimeMs: finiteNumber.optional(),
}).passthrough();

const historyMonthSchema = z.object({
    month: z.string(),
    tokens: finiteNumber,
    cost: finiteNumber,
    activeTimeMs: finiteNumber.optional(),
}).passthrough();

const historySummarySchema = z.object({
    totalTokens: finiteNumber,
    totalCost: finiteNumber,
    activeDays: finiteNumber,
    currentStreak: finiteNumber,
    longestStreak: finiteNumber,
    peakDayTokens: finiteNumber,
    favoriteModel: z.string(),
    messages: finiteNumber,
    activeTimeMs: finiteNumber.optional(),
}).passthrough();

const historyPreviewSchema = z.object({
    daily: z.array(historyDaySchema),
    monthly: z.array(historyMonthSchema),
    summary: historySummarySchema,
}).passthrough();

const fullStatsSchema = z.object({
    updatedAt: z.string(),
    periods: z.object({
        today: periodSchema,
        month: periodSchema,
        allTime: periodSchema,
    }).passthrough(),
    devices: z.array(deviceSchema),
    projectsIncomplete: z.boolean(),
    limits: limitsSchema,
    staleAfterMs: finiteNumber,
    historyPreview: historyPreviewSchema,
    historyRevision: z.string(),
    deviceHistoryRevision: z.string(),
    subscriptionsUpdatedAt: z.string(),
}).passthrough();

const freshnessDeviceSchema = z.object({
    deviceId: z.string(),
    updatedAt: z.string(),
    receivedAt: z.string(),
    ageMs: finiteNumber.nullable(),
    stale: z.boolean(),
});

const freshnessStatsSchema = z.object({
    updatedAt: z.string(),
    staleAfterMs: finiteNumber,
    limits: z.object({ updatedAt: z.string() }).optional(),
    devices: z.array(freshnessDeviceSchema),
});

const statsEnvelopeSchema = z.object({
    type: z.literal('stats'),
    reason: z.string(),
    stats: fullStatsSchema,
    at: z.string(),
});

const freshnessEnvelopeSchema = z.object({
    type: z.literal('freshness'),
    reason: z.string(),
    stats: freshnessStatsSchema,
    at: z.string(),
});

export type HubNotification = {
    kind: 'snapshot' | 'stats' | 'freshness';
    stats: Record<string, unknown>;
};

export function parseHubNotification(eventName: string, data: string): HubNotification {
    try {
        if (typeof eventName !== 'string' || typeof data !== 'string')
            throw new Error(INVALID_NOTIFICATION);

        const payload: unknown = JSON.parse(data);
        if (eventName === 'snapshot') {
            const parsed = statsEnvelopeSchema.parse(payload);
            return { kind: 'snapshot', stats: parsed.stats as Record<string, unknown> };
        }
        if (eventName === 'stats') {
            const parsed = statsEnvelopeSchema.parse(payload);
            return { kind: 'stats', stats: parsed.stats as Record<string, unknown> };
        }
        if (eventName === 'freshness') {
            const parsed = freshnessEnvelopeSchema.parse(payload);
            return { kind: 'freshness', stats: parsed.stats as Record<string, unknown> };
        }
        throw new Error(INVALID_NOTIFICATION);
    }
    catch {
        throw new Error(INVALID_NOTIFICATION);
    }
}
