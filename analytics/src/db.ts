import type {Database,Statement} from './platform.js';
import type {Batch} from './protocol.js';
import {advance,dayKey,type State,type Contract} from './estimate.js';
interface Latest {hub_id:string;event_id:string;observed_at:string}
// Caller serializes this short transaction in LiveRoom.blockConcurrencyWhile.
// D1 is the ONLY persistent authority. The DO never stores a second history copy.
export async function ingest(db:Database,batch:Batch,contracts:Contract[],timeZone:string):Promise<string[]>{
 const latestRows=await db.prepare('SELECT hub_id,event_id,observed_at FROM hub_latest').all<Latest>();
 const stateRows=await db.prepare('SELECT contract_id,state_json FROM contract_state').all<{contract_id:string;state_json:string}>();
 const latest=new Map(latestRows.results.map(r=>[r.hub_id,r]));
 const states=new Map(stateRows.results.map(r=>[r.contract_id,JSON.parse(r.state_json) as State]));
 const statements:Statement[]=[];const changed=new Set<string>();
 for(const o of batch.events){
  const exists=await db.prepare('SELECT event_id FROM observations WHERE hub_id=? AND event_id=?').bind(o.hubId,o.eventId).first();
  if(exists)continue;
  const payload=JSON.stringify(o);
  statements.push(db.prepare('INSERT INTO observations(hub_id,event_id,observed_at,received_at,stream_id,payload) VALUES(?,?,?,?,?,?)').bind(o.hubId,o.eventId,o.observedAt,o.receivedAt,o.streamId,payload));
  const prev=latest.get(o.hubId);
  // Late/replayed older data is archived, but must never move latest/baselines backwards.
  if(prev&&o.observedAt<=prev.observed_at)continue;
  latest.set(o.hubId,{hub_id:o.hubId,event_id:o.eventId,observed_at:o.observedAt});changed.add(o.hubId);
  statements.push(db.prepare(`INSERT INTO hub_latest(hub_id,event_id,observed_at) VALUES(?,?,?)
    ON CONFLICT(hub_id) DO UPDATE SET event_id=excluded.event_id,observed_at=excluded.observed_at`).bind(o.hubId,o.eventId,o.observedAt));
  for(const c of contracts.filter(c=>c.hubId===o.hubId)){
   const state=advance(c,o,states.get(c.id)??null);states.set(c.id,state);const r=state.result;
   statements.push(db.prepare(`INSERT INTO contract_state(contract_id,state_json) VALUES(?,?) ON CONFLICT(contract_id) DO UPDATE SET state_json=excluded.state_json`).bind(c.id,JSON.stringify(state)));
   statements.push(db.prepare(`INSERT INTO daily_estimates(contract_id,day,last_observed_at,status,reason,last_valid_at,window_capacity_usd,monthly_capacity_usd,estimate_json)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(contract_id,day) DO UPDATE SET
    last_observed_at=excluded.last_observed_at,status=excluded.status,reason=excluded.reason,
    last_valid_at=COALESCE(excluded.last_valid_at,daily_estimates.last_valid_at),
    window_capacity_usd=COALESCE(excluded.window_capacity_usd,daily_estimates.window_capacity_usd),
    monthly_capacity_usd=COALESCE(excluded.monthly_capacity_usd,daily_estimates.monthly_capacity_usd),
    estimate_json=COALESCE(excluded.estimate_json,daily_estimates.estimate_json)`)
    .bind(c.id,dayKey(o.observedAt,timeZone),o.observedAt,r.status,r.reason,r.status==='estimated'?o.observedAt:null,r.windowCapacityUsd,r.monthlyCapacityUsd,r.status==='estimated'?JSON.stringify(r):null));
  }
 }
 // <= 40 SQL queries including SELECTs with 2 events / <=8 contract definitions.
 if(statements.length)await db.batch(statements);
 return [...changed];
}
export async function dashboard(db:Database,contracts:Contract[]){
 const hubs=await db.prepare(`SELECT o.payload FROM hub_latest h JOIN observations o ON o.hub_id=h.hub_id AND o.event_id=h.event_id ORDER BY h.hub_id`).all<{payload:string}>();
 const rows=await db.prepare('SELECT contract_id,state_json FROM contract_state').all<{contract_id:string;state_json:string}>();
 return {hubs:hubs.results.map(r=>JSON.parse(r.payload)),estimates:rows.results.flatMap(r=>{
  const c=contracts.find(c=>c.id===r.contract_id);const s=JSON.parse(r.state_json) as State;
  return c&&s.signature===JSON.stringify(c)?[s.result]:[];
 })};
}
export async function history(db:Database,contractId:string){
 return (await db.prepare('SELECT * FROM daily_estimates WHERE contract_id=? ORDER BY day DESC LIMIT 90').bind(contractId).all()).results;
}
export async function prune(db:Database,days:number,now=Date.now()){
 const cutoff=new Date(now-days*86400000).toISOString();
 // Bounded maintenance; never remove the current snapshot for any Hub.
 return db.prepare(`DELETE FROM observations WHERE (hub_id,event_id) IN
 (SELECT o.hub_id,o.event_id FROM observations o WHERE o.observed_at<?
 AND NOT EXISTS(SELECT 1 FROM hub_latest h WHERE h.hub_id=o.hub_id AND h.event_id=o.event_id) LIMIT 500)`)
 .bind(cutoff).run();
}
