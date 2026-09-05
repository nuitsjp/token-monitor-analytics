import type {Contract} from './estimate.js';
// Server-only, deployed configuration. No secrets belong here.
export const settings = {
 timeZone: 'Asia/Tokyo',
 detailRetentionDays: 7,
 hubs: [{id:'hub-a',label:'Hub A'},{id:'hub-b',label:'Hub B'}],
 contracts: [] as Contract[]
};
// Synthetic local mode only. Never activated on a deployed hostname.
export const demoContract: Contract = {
 id:'demo-weekly',label:'DEMO / weekly',hubId:'hub-a',provider:'claude',accountKey:'demo-account',
 clientIds:['claude'],deviceIds:['demo-pc'],windowKind:'weekly',windowHours:168,
 monthlyFeeUsd:200,attributionConfirmed:true,minDeltaPercent:5,maxSourceSkewSeconds:120,maxGapSeconds:1800
};
