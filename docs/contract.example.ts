// Copy into analytics/src/settings.ts -> settings.contracts.
// This is ONE explicit account + device/client scope + limit window definition.
{
 id: 'claude-primary-weekly',
 label: 'Claude / primary / weekly',
 hubId: 'hub-a',
 provider: 'claude',
 accountKey: 'REPLACE_WITH_HASH_FROM_API_STATE',
 deviceIds: ['REPLACE_WITH_DEVICE_ID'],
 clientIds: ['claude'],
 windowKind: 'weekly',
 windowHours: 168,
 monthlyFeeUsd: null,
 attributionConfirmed: false,
 minDeltaPercent: 5,
 maxSourceSkewSeconds: 120,
 maxGapSeconds: 1800
}
