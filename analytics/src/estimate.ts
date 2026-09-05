import type {Observation} from './protocol.js';
export interface Contract {
 id:string; label:string; hubId:string; provider:string; accountKey:string;
 clientIds:string[]; deviceIds:string[]; windowKind:string; windowHours:number;
 monthlyFeeUsd:number|null; attributionConfirmed:boolean; minDeltaPercent:number;
 maxSourceSkewSeconds:number; maxGapSeconds:number;
}
interface Point {at:number; cost:number; percent:number; reset:string}
export interface Estimate {contractId:string;label:string;hubId:string;observedAt:string;status:'observing'|'estimated'|'unavailable';reason:string;windowCapacityUsd:number|null;monthlyCapacityUsd:number|null;valueRatio:number|null;deltaUsd:number|null;deltaPercent:number|null;windowKind:string;resetAt:string|null;baselineAt:string|null}
export interface State {signature:string;streamId:string;baseline:Point|null;previous:Point|null;result:Estimate}
const valid=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
export function validateContracts(cs:Contract[],hubs:string[]):void{
 if(cs.length>8)throw new Error('starter supports at most 8 contract/window definitions');
 const ids=new Set();for(const c of cs){
  if(!c.id||ids.has(c.id)||!hubs.includes(c.hubId)||!c.provider||!c.accountKey||!c.windowKind||!c.label)throw new Error('invalid or duplicate contract identity');ids.add(c.id);
  if(!c.clientIds.length||!c.deviceIds.length||new Set(c.clientIds).size!==c.clientIds.length||new Set(c.deviceIds).size!==c.deviceIds.length)throw new Error('contract source IDs must be nonempty and unique');
  if(!valid(c.windowHours)||c.windowHours===0||!valid(c.minDeltaPercent)||c.minDeltaPercent<1||c.minDeltaPercent>100||!valid(c.maxGapSeconds)||c.maxGapSeconds===0||!valid(c.maxSourceSkewSeconds)||(c.monthlyFeeUsd!==null&&(!valid(c.monthlyFeeUsd)||c.monthlyFeeUsd===0)))throw new Error('invalid contract limits');
 }
}
function point(c:Contract,o:Observation):[Point|null,string]{
 if(!c.attributionConfirmed)return [null,'attribution_unconfirmed'];
 const providers=o.stats.limits.providers.filter(p=>p.provider===c.provider&&p.accountKey===c.accountKey);
 if(providers.length!==1)return [null,'account_missing_or_ambiguous'];const p=providers[0]!;
 if(p.status!=='ok'||p.stale!==false)return [null,'limits_unavailable_or_stale'];
 const wins=p.windows.filter(w=>w.kind===c.windowKind);if(wins.length!==1)return [null,'window_missing_or_ambiguous'];const w=wins[0]!;
 const at=Date.parse(o.observedAt);if(!valid(w.usedPercent)||w.usedPercent>100||!Number.isFinite(Date.parse(w.resetsAt))||Date.parse(w.resetsAt)<=at)return [null,'window_invalid_or_expired'];
 const times=[Date.parse(p.updatedAt)];let cost=0;
 for(const id of c.deviceIds){const d=o.stats.devices.find(d=>d.deviceId===id);if(!d||d.stale!==false)return [null,'device_missing_or_stale'];times.push(Date.parse(d.updatedAt));
  for(const client of c.clientIds){const n=d.periods.allTime?.clientCosts?.[client];if(!valid(n))return [null,'cost_missing'];cost+=n;}
 }
 if(!Number.isFinite(cost)||times.some(t=>!Number.isFinite(t)||Math.abs(at-t)>c.maxGapSeconds*1000)||Math.max(...times)-Math.min(...times)>c.maxSourceSkewSeconds*1000)return [null,'source_time_mismatch'];
 return [{at,cost,percent:w.usedPercent,reset:new Date(w.resetsAt).toISOString()},''];
}
// Pure state machine. Cumulative deltas within one unchanged reset window;
// reconnects, corrections and source gaps establish a new baseline.
export function advance(c:Contract,o:Observation,old:State|null):State{
 const signature=JSON.stringify(c);const prior=old?.signature===signature?old:null;
 const [p,why]=point(c,o);
 const result:Estimate={contractId:c.id,label:c.label,hubId:c.hubId,observedAt:o.observedAt,status:'observing',reason:'baseline_started',windowCapacityUsd:null,monthlyCapacityUsd:null,valueRatio:null,deltaUsd:null,deltaPercent:null,windowKind:c.windowKind,resetAt:p?.reset??null,baselineAt:null};
 if(!p)return {signature,streamId:o.streamId,baseline:null,previous:null,result:{...result,status:'unavailable',reason:why}};
 let base=prior?.baseline??null;const prev=prior?.previous??null;
 let resetReason='';
 if(!base||!prev)resetReason='baseline_started';
 else if(prior!.streamId!==o.streamId)resetReason='stream_reconnected';
 else if(p.reset!==base.reset)resetReason='window_reset';
 else if(p.at<=prev.at)resetReason='out_of_order';
 else if(p.at-prev.at>c.maxGapSeconds*1000)resetReason='observation_gap';
 else if(p.cost<prev.cost-1e-8||p.percent<prev.percent-1e-8)resetReason='counter_decreased';
 if(resetReason){base=p;result.reason=resetReason;}
 else{
  const dc=p.cost-base!.cost,dp=p.percent-base!.percent;
  result.deltaUsd=dc;result.deltaPercent=dp;
  if(dp<c.minDeltaPercent){result.reason='insufficient_change';}
  else if(dc<=0){result.reason='cost_did_not_increase';}
  else{
   result.status='estimated';result.reason='observed_delta';result.windowCapacityUsd=dc/(dp/100);
   result.monthlyCapacityUsd=result.windowCapacityUsd*(365.2425/12*24/c.windowHours);
   result.valueRatio=c.monthlyFeeUsd===null?null:result.monthlyCapacityUsd/c.monthlyFeeUsd;
  }
 }
 if(result.windowCapacityUsd!==null&&(!Number.isFinite(result.windowCapacityUsd)||!Number.isFinite(result.monthlyCapacityUsd))){
  result.status='unavailable';result.reason='estimate_out_of_range';result.windowCapacityUsd=null;result.monthlyCapacityUsd=null;result.valueRatio=null;
 }
 if(result.valueRatio!==null&&!Number.isFinite(result.valueRatio))result.valueRatio=null;
 result.baselineAt=new Date(base!.at).toISOString();return {signature,streamId:o.streamId,baseline:base,previous:p,result};
}
export function dayKey(iso:string,timeZone:string):string{
 const parts=new Intl.DateTimeFormat('en',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso));
 const get=(type:string)=>parts.find(p=>p.type===type)!.value;return `${get('year')}-${get('month')}-${get('day')}`;
}
