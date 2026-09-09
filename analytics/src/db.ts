import type {Database} from './platform.ts';
import type {Batch,Observation,TransportObservation} from './protocol.ts';
import {advance,dayKey,type State,type Contract} from './estimate.ts';
interface Latest {hub_id:string;event_id:string;observed_at:string}
function newEventId(): string {
 const bytes=new Uint8Array(16);
 globalThis.crypto.getRandomValues(bytes);
 return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}
function internalObservation(input:Observation|TransportObservation):Observation {
 const {schemaVersion: _schemaVersion,eventId: _eventId,...observation}=input as TransportObservation;
 return observation;
}

// Read baseline → save observation → update latest → estimate → daily row, all sync.
// The caller owns BEGIN IMMEDIATE. Network and Secret I/O stay outside the transaction.
function recordMany(db:Database,inputs:readonly Observation[],contracts:Contract[],timeZone:string,legacyIds?:readonly (string|undefined)[]):string[]{
 const latestRows=db.prepare('SELECT hub_id,event_id,observed_at FROM hub_latest').all<Latest>();
 const stateRows=db.prepare('SELECT contract_id,state_json FROM contract_state').all<{contract_id:string;state_json:string}>();
 const latest=new Map(latestRows.map(r=>[r.hub_id,r]));
 const states=new Map(stateRows.map(r=>[r.contract_id,JSON.parse(r.state_json) as State]));
 const changed=new Set<string>();
 for(const [index,input] of inputs.entries()){
  const eventId=legacyIds?.[index]??newEventId();
  const observation:Observation & {schemaVersion:1;eventId:string}={
   schemaVersion:1,hubId:input.hubId,streamId:input.streamId,kind:input.kind,
   observedAt:input.observedAt,receivedAt:input.receivedAt,stats:input.stats,eventId
  };
  const exists=db.prepare('SELECT event_id FROM observations WHERE hub_id=? AND event_id=?').bind(observation.hubId,eventId).get();
  if(exists)continue;
  const payload=JSON.stringify(observation);
  db.prepare('INSERT INTO observations(hub_id,event_id,observed_at,received_at,stream_id,payload) VALUES(?,?,?,?,?,?)')
   .bind(observation.hubId,eventId,observation.observedAt,observation.receivedAt,observation.streamId,payload).run();
  const prev=latest.get(observation.hubId);
  // Late/replayed older data is archived, but must never move latest/baselines backwards.
  if(prev&&observation.observedAt<=prev.observed_at)continue;
  latest.set(observation.hubId,{hub_id:observation.hubId,event_id:eventId,observed_at:observation.observedAt});changed.add(observation.hubId);
  db.prepare(`INSERT INTO hub_latest(hub_id,event_id,observed_at) VALUES(?,?,?)
    ON CONFLICT(hub_id) DO UPDATE SET event_id=excluded.event_id,observed_at=excluded.observed_at`)
   .bind(observation.hubId,eventId,observation.observedAt).run();
  for(const c of contracts.filter(c=>c.hubId===observation.hubId)){
   const state=advance(c,observation,states.get(c.id)??null);states.set(c.id,state);const r=state.result;
   db.prepare(`INSERT INTO contract_state(contract_id,state_json) VALUES(?,?) ON CONFLICT(contract_id) DO UPDATE SET state_json=excluded.state_json`)
    .bind(c.id,JSON.stringify(state)).run();
   db.prepare(`INSERT INTO daily_estimates(contract_id,day,last_observed_at,status,reason,last_valid_at,window_capacity_usd,monthly_capacity_usd,estimate_json)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(contract_id,day) DO UPDATE SET
    last_observed_at=excluded.last_observed_at,status=excluded.status,reason=excluded.reason,
    last_valid_at=COALESCE(excluded.last_valid_at,daily_estimates.last_valid_at),
    window_capacity_usd=COALESCE(excluded.window_capacity_usd,daily_estimates.window_capacity_usd),
    monthly_capacity_usd=COALESCE(excluded.monthly_capacity_usd,daily_estimates.monthly_capacity_usd),
    estimate_json=COALESCE(excluded.estimate_json,daily_estimates.estimate_json)`)
    .bind(c.id,dayKey(observation.observedAt,timeZone),observation.observedAt,r.status,r.reason,r.status==='estimated'?observation.observedAt:null,r.windowCapacityUsd,r.monthlyCapacityUsd,r.status==='estimated'?JSON.stringify(r):null).run();
  }
 }
 return [...changed];
}

export function recordObservations(db:Database,inputs:readonly Observation[],contracts:Contract[],timeZone:string):string[]{
 return recordMany(db,inputs,contracts,timeZone);
}
export function recordObservation(db:Database,input:Observation,contracts:Contract[],timeZone:string):string[]{
 return recordMany(db,[input],contracts,timeZone);
}
/** @deprecated Prefer recordObservation/recordObservations. Kept for the HTTP bridge. */
export function ingest(db:Database,batch:Batch,contracts:Contract[],timeZone:string):string[]{
 const inputs=batch.events.map(internalObservation);
 return recordMany(db,inputs,contracts,timeZone,batch.events.map(event=>event.eventId));
}

export function dashboard(db:Database,contracts:Contract[]){
 const hubs=db.prepare(`SELECT o.payload FROM hub_latest h JOIN observations o ON o.hub_id=h.hub_id AND o.event_id=h.event_id ORDER BY h.hub_id`).all<{payload:string}>();
 const rows=db.prepare('SELECT contract_id,state_json FROM contract_state').all<{contract_id:string;state_json:string}>();
 return {hubs:hubs.map(r=>JSON.parse(r.payload)),estimates:rows.flatMap(r=>{
  const c=contracts.find(c=>c.id===r.contract_id);const s=JSON.parse(r.state_json) as State;
  return c&&s.signature===JSON.stringify(c)?[s.result]:[];
 })};
}

export function history(db:Database,contractId:string){
 return db.prepare('SELECT * FROM daily_estimates WHERE contract_id=? ORDER BY day DESC LIMIT 90').bind(contractId).all();
}
export function prune(db:Database,days:number,now=Date.now()){
 const cutoff=new Date(now-days*86400000).toISOString();
 // Bounded maintenance; never remove the current snapshot for any Hub.
 return db.prepare(`DELETE FROM observations WHERE (hub_id,event_id) IN
 (SELECT o.hub_id,o.event_id FROM observations o WHERE o.observed_at<?
 AND NOT EXISTS(SELECT 1 FROM hub_latest h WHERE h.hub_id=o.hub_id AND h.event_id=o.event_id) LIMIT 500)`)
 .bind(cutoff).run();
}
