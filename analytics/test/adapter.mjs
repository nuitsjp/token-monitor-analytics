import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
// Real SQLite SQL tests, but NOT the Cloudflare D1 runtime or its metering.
export function database(path=':memory:'){
 const sql=new DatabaseSync(path);sql.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const wrap=(text,args=[])=>({bind(...a){return wrap(text,a)},async all(){return {results:sql.prepare(text).all(...args),success:true,meta:{}}},async first(){return sql.prepare(text).get(...args)??null},async run(){const r=sql.prepare(text).run(...args);return {results:[],success:true,meta:{changes:Number(r.changes)}}}});
 return {sql,prepare:wrap,async batch(ss){sql.exec('BEGIN');try{const r=[];for(const s of ss)r.push(await s.run());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};
}
export const contract={id:'test-weekly',label:'Test',hubId:'hub-a',provider:'claude',accountKey:'account',clientIds:['claude'],deviceIds:['pc'],windowKind:'weekly',windowHours:168,monthlyFeeUsd:200,attributionConfirmed:true,minDeltaPercent:5,maxSourceSkewSeconds:120,maxGapSeconds:1800};
export function observation(n=0,opts={}){
 const at=new Date(Date.parse('2026-09-05T00:00:00Z')+n*60000).toISOString();
 return {schemaVersion:1,hubId:'hub-a',eventId:String(n+1).padStart(32,'0'),streamId:'a'.repeat(32),kind:n===0?'snapshot':'stats',observedAt:at,receivedAt:at,stats:{updatedAt:at,periods:{today:{costUsd:100+n*8},month:{costUsd:100+n*8},allTime:{costUsd:100+n*8}},devices:[{deviceId:'pc',updatedAt:at,stale:false,periods:{allTime:{costUsd:100+n*8,clientCosts:{claude:100+n*8}}}}],limits:{providers:[{provider:'claude',accountKey:'account',updatedAt:at,status:'ok',stale:false,windows:[{kind:'weekly',usedPercent:10+n*5,resetsAt:'2026-09-12T00:00:00Z'}]}]}},...opts};
}
