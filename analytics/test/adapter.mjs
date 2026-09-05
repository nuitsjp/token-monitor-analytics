import {openDatabase} from '../runtime/sqlite.mjs';
export const database=(filename=':memory:')=>openDatabase(filename);
export const contract={id:'test-weekly',label:'Test',hubId:'hub-a',provider:'claude',accountKey:'account',clientIds:['claude'],deviceIds:['pc'],windowKind:'weekly',windowHours:168,monthlyFeeUsd:200,attributionConfirmed:true,minDeltaPercent:5,maxSourceSkewSeconds:120,maxGapSeconds:1800};
export function observation(n=0,opts={}){
 const at=new Date(Date.parse('2026-09-05T00:00:00Z')+n*60000).toISOString();
 return {schemaVersion:1,hubId:'hub-a',eventId:String(n+1).padStart(32,'0'),streamId:'a'.repeat(32),kind:n===0?'snapshot':'stats',observedAt:at,receivedAt:at,stats:{updatedAt:at,periods:{today:{costUsd:100+n*8},month:{costUsd:100+n*8},allTime:{costUsd:100+n*8}},devices:[{deviceId:'pc',updatedAt:at,stale:false,periods:{allTime:{costUsd:100+n*8,clientCosts:{claude:100+n*8}}}}],limits:{providers:[{provider:'claude',accountKey:'account',updatedAt:at,status:'ok',stale:false,windows:[{kind:'weekly',usedPercent:10+n*5,resetsAt:'2026-09-12T00:00:00Z'}]}]}},...opts};
}
