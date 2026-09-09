import type {Database} from './platform.ts';
import type {Batch,Observation,TransportObservation} from './protocol.ts';
import type {HistoryGranularity,HistoryRow,NormalizedHistoryDevice,NormalizedHistoryResponse} from './history.ts';
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

// ---- Device History -------------------------------------------------------
//
// History fetches deliberately have a different storage boundary from live
// observations.  A fetch is a complete, validated snapshot of device records;
// applying it replaces rows for the same device/period and never adds them.
// Every function below is synchronous and expects the caller to own the short
// BEGIN IMMEDIATE transaction, just like recordObservation().

export interface HistoryFetchStatus {
 hubId:string;
 nextFetchId:number;
 latestSuccessFetchId:number|null;
 latestSuccessAt:string|null;
 lastAttemptFetchId:number|null;
 lastAttemptAt:string|null;
 lastStatus:string;
 lastError:string|null;
}

export interface UsageHistoryQuery {
 hubId:string;
 deviceId:string;
 granularity:HistoryGranularity;
 from:string;
 to:string;
}

interface StoredHistoryPeriod {
 hub_id:string;device_id:string;granularity:HistoryGranularity;period_key:string;
 total_tokens:number|null;cost_usd:number|null;messages:number|null;active_time_ms:number|null;
 cache_read_tokens:number|null;cache_write_tokens:number|null;output_tokens:number|null;unclassified_tokens:number|null;
 token_components_available:number|null;per_client_json:string;per_model_json:string;source_time_zone:string|null;
 confirmed_fetch_id:number;confirmed_at:string;
}

interface StoredHistorySource {
 hub_id:string;device_id:string;presence:'present'|'deleted';history_state:string;history_available:number|null;
 time_zone:string|null;today_key:string|null;today_ends_at:string|null;month_key:string|null;month_ends_at:string|null;
 daily_from:string|null;daily_to:string|null;monthly_from:string|null;monthly_to:string|null;
 upstream_updated_at:string|null;last_fetch_id:number;last_confirmed_at:string;
}

interface StoredHistoryFetch {
 hub_id:string;next_fetch_id:number;latest_success_fetch_id:number|null;latest_success_at:string|null;
 last_attempt_fetch_id:number|null;last_attempt_at:string|null;last_status:string;last_error:string|null;
}

function requireHistoryIdentity(value:string,label:string):void {
 if(typeof value!=='string'||value.length===0||value.length>256)throw new Error(`invalid ${label}`);
}

function historyFetchRow(db:Database,hubId:string):StoredHistoryFetch|null {
 return db.prepare('SELECT * FROM usage_fetches WHERE hub_id=?').bind(hubId).get<StoredHistoryFetch>();
}

/** Allocate one local request number before network I/O. */
export function beginHistoryFetch(db:Database,hubId:string,startedAt=new Date().toISOString()):number {
 requireHistoryIdentity(hubId,'Hub ID');
 const current=historyFetchRow(db,hubId);
 const next=Number(current?.next_fetch_id??0)+1;
 db.prepare(`INSERT INTO usage_fetches(hub_id,next_fetch_id,last_attempt_fetch_id,last_attempt_at,last_status,last_error)
   VALUES(?,?,?,?,?,NULL)
   ON CONFLICT(hub_id) DO UPDATE SET next_fetch_id=excluded.next_fetch_id,
   last_attempt_fetch_id=excluded.last_attempt_fetch_id,last_attempt_at=excluded.last_attempt_at,
   last_status=excluded.last_status,last_error=NULL`)
  .bind(hubId,next,next,startedAt,'running').run();
 return next;
}

function ensureFetchRow(db:Database,hubId:string,fetchId:number,at:string):void {
 const current=historyFetchRow(db,hubId);
 if(current)return;
 db.prepare(`INSERT INTO usage_fetches(hub_id,next_fetch_id,last_attempt_fetch_id,last_attempt_at,last_status)
   VALUES(?,?,?,?,?)`).bind(hubId,fetchId,fetchId,at,'running').run();
}

/** Record an error without touching any previously committed source/period row. */
export function recordHistoryFetchFailure(db:Database,hubId:string,fetchId:number,error:string,at=new Date().toISOString()):void {
 requireHistoryIdentity(hubId,'Hub ID');
 if(!Number.isSafeInteger(fetchId)||fetchId<1)throw new Error('invalid history fetch ID');
 const safeError=typeof error==='string'?error.slice(0,512):'history fetch failed';
 ensureFetchRow(db,hubId,fetchId,at);
 db.prepare(`UPDATE usage_fetches SET last_status='error',last_error=?
   WHERE hub_id=? AND last_attempt_fetch_id=?`).bind(safeError,hubId,fetchId).run();
}

function mapJson(value:unknown):string { return JSON.stringify(value??{}); }

function sourceRange(rows:readonly HistoryRow[],granularity:HistoryGranularity):[string|null,string|null] {
 const keys=rows.filter(row=>row.granularity===granularity).map(row=>row.periodKey).sort();
 return [keys[0]??null,keys.at(-1)??null];
}

function historyAvailability(value:boolean|null):number|null {
 return value===null?null:value?1:0;
}

function storeHistoryDevice(db:Database,hubId:string,device:NormalizedHistoryDevice,fetchId:number,confirmedAt:string):void {
 const [dailyFrom,dailyTo]=sourceRange(device.rows,'daily');
 const [monthlyFrom,monthlyTo]=sourceRange(device.rows,'monthly');
 db.prepare(`INSERT INTO usage_sources(
   hub_id,device_id,presence,history_state,history_available,time_zone,
   today_key,today_ends_at,month_key,month_ends_at,daily_from,daily_to,
   monthly_from,monthly_to,upstream_updated_at,last_fetch_id,last_confirmed_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(hub_id,device_id) DO UPDATE SET
   presence=excluded.presence,history_state=excluded.history_state,
   history_available=excluded.history_available,time_zone=excluded.time_zone,
   today_key=excluded.today_key,today_ends_at=excluded.today_ends_at,
   month_key=excluded.month_key,month_ends_at=excluded.month_ends_at,
   daily_from=excluded.daily_from,daily_to=excluded.daily_to,
   monthly_from=excluded.monthly_from,monthly_to=excluded.monthly_to,
   upstream_updated_at=excluded.upstream_updated_at,last_fetch_id=excluded.last_fetch_id,
   last_confirmed_at=excluded.last_confirmed_at`)
  .bind(hubId,device.deviceId,'present',device.historyState,historyAvailability(device.historyAvailable),device.timeZone,
   device.windows.todayKey,device.windows.todayEndsAt,device.windows.monthKey,device.windows.monthEndsAt,
   dailyFrom,dailyTo,monthlyFrom,monthlyTo,device.upstreamUpdatedAt,fetchId,confirmedAt).run();

 // A valid row is a replacement for exactly one source period.  Omitted old
 // rows are intentionally left untouched and remain visibly older through their
 // confirmed_fetch_id/confirmed_at values.
 for(const row of device.historyState==='available'?device.rows:[]) {
  db.prepare(`INSERT INTO usage_periods(
    hub_id,device_id,granularity,period_key,total_tokens,cost_usd,messages,active_time_ms,
    cache_read_tokens,cache_write_tokens,output_tokens,unclassified_tokens,
    token_components_available,per_client_json,per_model_json,source_time_zone,
    confirmed_fetch_id,confirmed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(hub_id,device_id,granularity,period_key) DO UPDATE SET
    total_tokens=excluded.total_tokens,cost_usd=excluded.cost_usd,messages=excluded.messages,
    active_time_ms=excluded.active_time_ms,cache_read_tokens=excluded.cache_read_tokens,
    cache_write_tokens=excluded.cache_write_tokens,output_tokens=excluded.output_tokens,
    unclassified_tokens=excluded.unclassified_tokens,
    token_components_available=excluded.token_components_available,
    per_client_json=excluded.per_client_json,per_model_json=excluded.per_model_json,
    source_time_zone=excluded.source_time_zone,confirmed_fetch_id=excluded.confirmed_fetch_id,
    confirmed_at=excluded.confirmed_at`)
   .bind(hubId,device.deviceId,row.granularity,row.periodKey,row.tokens,row.costUsd,row.messages,row.activeTimeMs,
    row.cacheReadTokens,row.cacheWriteTokens,row.outputTokens,row.unclassifiedTokens,
    row.tokenComponentsAvailable===null?null:row.tokenComponentsAvailable?1:0,
    // periodWindows describes the producer's current live window. It does not
    // establish the calendar used by every retained historical row, so keep the
    // row's date basis unknown unless the row carries one explicitly (it does
    // not in the current Hub contract).
    mapJson(row.perClient),mapJson(row.perModel),null,fetchId,confirmedAt).run();
 }
}

/** Apply one complete normalized response atomically. */
export function storeHistorySnapshot(db:Database,hubId:string,response:NormalizedHistoryResponse,fetchId:number,confirmedAt=new Date().toISOString()):string[] {
 requireHistoryIdentity(hubId,'Hub ID');
 if(!Number.isSafeInteger(fetchId)||fetchId<1)throw new Error('invalid history fetch ID');
 const current=historyFetchRow(db,hubId);
 if(current&&Number(current.last_attempt_fetch_id)!==fetchId)throw Object.assign(new Error('stale history fetch'),{code:'stale_fetch'});
 ensureFetchRow(db,hubId,fetchId,confirmedAt);
 const seen=new Set<string>();
 for(const device of response.devices){
  if(seen.has(device.deviceId))throw new Error('duplicate history deviceId');
  seen.add(device.deviceId);
  storeHistoryDevice(db,hubId,device,fetchId,confirmedAt);
 }
 // `/api/devices` is a complete current device listing. A previously known
 // device missing from it was removed upstream; retain its rows for explicit
 // device history, but stop considering them current source data.
 const prior=db.prepare('SELECT device_id FROM usage_sources WHERE hub_id=?').bind(hubId).all<{device_id:string}>();
 for(const row of prior){
  if(seen.has(row.device_id))continue;
  db.prepare(`UPDATE usage_sources SET presence='deleted',history_state='deleted',history_available=NULL,
    time_zone=NULL,today_key=NULL,today_ends_at=NULL,month_key=NULL,month_ends_at=NULL,
    daily_from=NULL,daily_to=NULL,monthly_from=NULL,monthly_to=NULL,upstream_updated_at=NULL,
    last_fetch_id=?,last_confirmed_at=? WHERE hub_id=? AND device_id=?`)
   .bind(fetchId,confirmedAt,hubId,row.device_id).run();
 }
 db.prepare(`UPDATE usage_fetches SET latest_success_fetch_id=?,latest_success_at=?,last_status='success',last_error=NULL
   WHERE hub_id=? AND last_attempt_fetch_id=?`)
  .bind(fetchId,confirmedAt,hubId,fetchId).run();
 return [...seen];
}

export function historyFetchStatus(db:Database,hubId:string):HistoryFetchStatus|null {
 const row=historyFetchRow(db,hubId);
 if(!row)return null;
 return {
  hubId:row.hub_id,nextFetchId:Number(row.next_fetch_id),latestSuccessFetchId:row.latest_success_fetch_id===null?null:Number(row.latest_success_fetch_id),
  latestSuccessAt:row.latest_success_at,lastAttemptFetchId:row.last_attempt_fetch_id===null?null:Number(row.last_attempt_fetch_id),
  lastAttemptAt:row.last_attempt_at,lastStatus:row.last_status,lastError:row.last_error
 };
}

function decodeMap(value:string):Record<string,unknown> {
 try { const parsed:unknown=JSON.parse(value); return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{}; }
 catch { return {}; }
}

function sourceView(source:StoredHistorySource|null):Record<string,unknown>|null {
 if(!source)return null;
 return {
  hubId:source.hub_id,deviceId:source.device_id,presence:source.presence,historyState:source.history_state,
  historyAvailable:source.history_available===null?null:source.history_available===1,
  timeZone:source.time_zone,todayKey:source.today_key,todayEndsAt:source.today_ends_at,
  monthKey:source.month_key,monthEndsAt:source.month_ends_at,dailyFrom:source.daily_from,dailyTo:source.daily_to,
  monthlyFrom:source.monthly_from,monthlyTo:source.monthly_to,upstreamUpdatedAt:source.upstream_updated_at,
  lastFetchId:Number(source.last_fetch_id),lastConfirmedAt:source.last_confirmed_at
 };
}

function historyRowView(row:StoredHistoryPeriod,source:StoredHistorySource|null):Record<string,unknown> {
 const current=source!==null&&source.presence==='present'&&source.history_state==='available'&&source.last_fetch_id===row.confirmed_fetch_id;
 return {
  hubId:row.hub_id,deviceId:row.device_id,granularity:row.granularity,periodKey:row.period_key,
  tokens:row.total_tokens,costUsd:row.cost_usd,messages:row.messages,activeTimeMs:row.active_time_ms,
  cacheReadTokens:row.cache_read_tokens,cacheWriteTokens:row.cache_write_tokens,outputTokens:row.output_tokens,
  unclassifiedTokens:row.unclassified_tokens,tokenComponentsAvailable:row.token_components_available===null?null:row.token_components_available===1,
  perClient:decodeMap(row.per_client_json),perModel:decodeMap(row.per_model_json),sourceTimeZone:row.source_time_zone,
  confirmedFetchId:Number(row.confirmed_fetch_id),confirmedAt:row.confirmed_at,current
 };
}

/** Read one bounded device/granularity range; no cross-device aggregation occurs here. */
export function readUsageHistory(db:Database,query:UsageHistoryQuery):Record<string,unknown> {
 requireHistoryIdentity(query.hubId,'Hub ID');
 requireHistoryIdentity(query.deviceId,'device ID');
 if(query.granularity!=='daily'&&query.granularity!=='monthly')throw new Error('invalid history granularity');
 const rows=db.prepare(`SELECT * FROM usage_periods WHERE hub_id=? AND device_id=? AND granularity=?
   AND period_key>=? AND period_key<=? ORDER BY period_key`).bind(query.hubId,query.deviceId,query.granularity,query.from,query.to).all<StoredHistoryPeriod>();
 const source=db.prepare('SELECT * FROM usage_sources WHERE hub_id=? AND device_id=?').bind(query.hubId,query.deviceId).get<StoredHistorySource>();
 return {hubId:query.hubId,deviceId:query.deviceId,granularity:query.granularity,from:query.from,to:query.to,
  rows:rows.map(row=>historyRowView(row,source)),source:sourceView(source)};
}

export function listUsageHistorySources(db:Database,hubId:string):Record<string,unknown>[] {
 requireHistoryIdentity(hubId,'Hub ID');
 return db.prepare('SELECT * FROM usage_sources WHERE hub_id=? ORDER BY device_id').bind(hubId).all<StoredHistorySource>().map(row=>sourceView(row) as Record<string,unknown>);
}
