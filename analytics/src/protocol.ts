export interface Period { costUsd: number | null; totalTokens?: number | null; clientCosts?: Record<string, number | null> }
export interface Device { deviceId: string; updatedAt: string; stale: boolean | null; periods: Record<string, Period> }
export interface LimitWindow { kind: string; usedPercent: number | null; resetsAt: string }
export interface Provider {provider: string; accountKey: string; updatedAt: string; status: string; stale: boolean | null; windows: LimitWindow[]}
export interface Stats {updatedAt: string; periods: Record<string, Period>; devices: Device[]; limits: {providers: Provider[]}}
// Internal observation passed from collection to storage. Transport metadata such
// as schemaVersion and the upstream eventId is intentionally not required here.
export interface Observation {hubId: string; streamId: string; kind: 'snapshot'|'stats'; observedAt: string; receivedAt: string; stats: Stats}
// Transitional HTTP input. The old endpoint is the only caller that needs these fields.
export interface TransportObservation extends Observation {schemaVersion: 1; eventId: string}
export interface Batch {schemaVersion: 1; events: TransportObservation[]}
export interface HubStreamEvent {name: string; data: string}
/** An upstream payload error stops only the affected Hub subscription. */
export class HubInputError extends Error {
 readonly code = 'input_error';
 readonly permanent = true;
 constructor(message: string){super(message);this.name='HubInputError';}
}
const obj=(v:unknown):v is Record<string,unknown> => v!==null&&typeof v==='object'&&!Array.isArray(v);
const str=(v:unknown,max=256):v is string => typeof v==='string'&&v.length<=max;
const finite=(v:unknown):boolean => v===null||(typeof v==='number'&&Number.isFinite(v)&&v>=0);
const date=(v:unknown):v is string => str(v,64)&&Number.isFinite(Date.parse(v));
const optionalDate=(v:unknown)=>v===''||date(v);
function period(v: unknown): boolean {
 if(!obj(v)||!finite(v.costUsd)) return false;
 if(v.totalTokens!==undefined&&!finite(v.totalTokens)) return false;
 if(v.clientCosts!==undefined){if(!obj(v.clientCosts)||Object.keys(v.clientCosts).length>128)return false;for(const n of Object.values(v.clientCosts)){if(!finite(n))return false;}}
 return true;
}
function periods(v:unknown):boolean {return obj(v)&&Object.keys(v).length<=3&&Object.entries(v).every(([k,p])=>['today','month','allTime'].includes(k)&&period(p));}
function stats(v:unknown):v is Stats{
 if(!obj(v)||!optionalDate(v.updatedAt)||!periods(v.periods)||!Array.isArray(v.devices)||v.devices.length>64||!obj(v.limits)||!Array.isArray(v.limits.providers)||v.limits.providers.length>64)return false;
 const ids=new Set();for(const d of v.devices){if(!obj(d)||!str(d.deviceId)||!d.deviceId||ids.has(d.deviceId)||!optionalDate(d.updatedAt)||![true,false,null].includes(d.stale as boolean|null)||!periods(d.periods))return false;ids.add(d.deviceId);}
 for(const p of v.limits.providers){
  if(!obj(p)||!str(p.provider,64)||!str(p.accountKey)||!str(p.status,64)||!optionalDate(p.updatedAt)||![true,false,null].includes(p.stale as boolean|null)||!Array.isArray(p.windows)||p.windows.length>32)return false;
  for(const x of p.windows){if(!obj(x)||!str(x.kind,64)||!str(x.resetsAt,64)||!finite(x.usedPercent)||(typeof x.usedPercent==='number'&&x.usedPercent>100))return false;}
 }
 return true;
}
function copyPeriod(p:Period):Period{const out:Period={costUsd:p.costUsd};if(p.totalTokens!==undefined)out.totalTokens=p.totalTokens;if(p.clientCosts!==undefined)out.clientCosts={...p.clientCosts};return out;}
function copyPeriods(ps:Record<string,Period>):Record<string,Period>{return Object.fromEntries(Object.entries(ps).map(([k,p])=>[k,copyPeriod(p)]));}
function cleanStats(s:Stats):Stats{return {updatedAt:s.updatedAt,periods:copyPeriods(s.periods),devices:s.devices.map(d=>({deviceId:d.deviceId,updatedAt:d.updatedAt,stale:d.stale,periods:copyPeriods(d.periods)})),limits:{providers:s.limits.providers.map(p=>({provider:p.provider,accountKey:p.accountKey,updatedAt:p.updatedAt,status:p.status,stale:p.stale,windows:p.windows.map(w=>({kind:w.kind,usedPercent:w.usedPercent,resetsAt:w.resetsAt}))}))}};}
function compactPeriod(v:unknown):Period{
 if(!obj(v)||!finite(v.costUsd))throw new HubInputError('invalid Hub period');
 const out:Period={costUsd:v.costUsd as number|null};
 if(v.totalTokens!==undefined){if(!finite(v.totalTokens))throw new HubInputError('invalid Hub period');out.totalTokens=v.totalTokens as number|null;}
 if(v.clientCosts!==undefined){
  if(!obj(v.clientCosts)||Object.keys(v.clientCosts).length>128)throw new HubInputError('invalid Hub period');
  for(const value of Object.values(v.clientCosts))if(!finite(value))throw new HubInputError('invalid Hub period');
  out.clientCosts={...v.clientCosts as Record<string,number|null>};
 }
 return out;
}

// Compact one Hub SSE event into the synchronous storage boundary. Unknown
// upstream fields are deliberately discarded before the event is persisted.
export function compactHubEvent(event:HubStreamEvent,hubId:string,streamId:string,now=Date.now()):Observation{
 try{
  if(event.name!=='snapshot'&&event.name!=='stats')throw new HubInputError('unknown SSE event');
  if(!str(hubId,64)||!hubId||!str(streamId,64)||!streamId)throw new HubInputError('invalid Hub identity');
  if(typeof event.data!=='string')throw new HubInputError('invalid Hub JSON');
  let envelope:unknown;
  try{envelope=JSON.parse(event.data);}catch{throw new HubInputError('invalid Hub JSON');}
  if(!obj(envelope)||envelope.type!=='stats'||!obj(envelope.stats)||!obj(envelope.stats.periods)||typeof envelope.at!=='string')throw new HubInputError('missing Hub type/stats/periods/at');
  const at=Date.parse(envelope.at);if(!Number.isFinite(at))throw new HubInputError('missing Hub type/stats/periods/at');
  if(at>now+300000)throw new HubInputError('Hub clock is over five minutes ahead');
  const rawStats=envelope.stats,rawPeriods=rawStats.periods as Record<string,unknown>,periodMap:Record<string,unknown>={};
  if(rawStats.updatedAt!==undefined&&rawStats.updatedAt!==null&&typeof rawStats.updatedAt!=='string')throw new HubInputError('invalid Hub stats payload');
  for(const key of ['today','month','allTime'])if(Object.prototype.hasOwnProperty.call(rawPeriods,key))periodMap[key]=compactPeriod(rawPeriods[key]);
  const rawDevices=rawStats.devices===undefined||rawStats.devices===null?[]:rawStats.devices;
  if(!Array.isArray(rawDevices))throw new HubInputError('invalid Hub stats payload');
  if(rawDevices.length>64)throw new HubInputError('Hub exceeds starter device/account limit');
  const ids=new Set<string>(),devices:Device[]=[];
  for(const raw of rawDevices){
   if(!obj(raw)||typeof raw.deviceId!=='string'||!raw.deviceId||ids.has(raw.deviceId))throw new HubInputError('empty/duplicate deviceId');
   if(raw.updatedAt!==undefined&&raw.updatedAt!==null&&typeof raw.updatedAt!=='string')throw new HubInputError('invalid Hub stats payload');
   if(raw.stale!==undefined&&raw.stale!==null&&typeof raw.stale!=='boolean')throw new HubInputError('invalid Hub stats payload');
   const devicePeriods=raw.periods===undefined||raw.periods===null?{}:raw.periods;if(!obj(devicePeriods))throw new HubInputError('invalid Hub stats payload');
   const allTime=devicePeriods.allTime;
   ids.add(raw.deviceId);devices.push({deviceId:raw.deviceId,updatedAt:raw.updatedAt===undefined||raw.updatedAt===null?'':raw.updatedAt,stale:raw.stale===undefined?null:raw.stale,periods:allTime===undefined||allTime===null?{}:{allTime:compactPeriod(allTime)}});
  }
  const rawLimits=rawStats.limits===undefined||rawStats.limits===null?{}:rawStats.limits;if(!obj(rawLimits))throw new HubInputError('invalid Hub stats payload');
  const rawProviders=rawLimits.providers===undefined||rawLimits.providers===null?[]:rawLimits.providers;
  if(!Array.isArray(rawProviders)||rawProviders.length>64)throw new HubInputError('Hub exceeds starter device/account limit');
  const providers:Provider[]=[];
  for(const raw of rawProviders){
   if(!obj(raw))throw new HubInputError('invalid Hub stats payload');
   if(raw.provider!==undefined&&typeof raw.provider!=='string')throw new HubInputError('invalid Hub stats payload');
   if(raw.accountKey!==undefined&&raw.accountKey!==null&&typeof raw.accountKey!=='string')throw new HubInputError('invalid Hub stats payload');
   if(raw.updatedAt!==undefined&&raw.updatedAt!==null&&typeof raw.updatedAt!=='string')throw new HubInputError('invalid Hub stats payload');
   if(raw.status!==undefined&&raw.status!==null&&typeof raw.status!=='string')throw new HubInputError('invalid Hub stats payload');
   if(raw.stale!==undefined&&raw.stale!==null&&typeof raw.stale!=='boolean')throw new HubInputError('invalid Hub stats payload');
   const rawWindows=raw.windows===undefined||raw.windows===null?[]:raw.windows;if(!Array.isArray(rawWindows))throw new HubInputError('invalid Hub stats payload');
   const windows:LimitWindow[]=[];
   for(const window of rawWindows){
    if(!obj(window))throw new HubInputError('invalid Hub stats payload');
    if(window.kind!==undefined&&window.kind!==null&&typeof window.kind!=='string')throw new HubInputError('invalid Hub stats payload');
    if(window.resetsAt!==undefined&&window.resetsAt!==null&&typeof window.resetsAt!=='string')throw new HubInputError('invalid Hub stats payload');
    if(window.usedPercent!==undefined&&window.usedPercent!==null&&typeof window.usedPercent!=='number')throw new HubInputError('invalid Hub stats payload');
    windows.push({kind:window.kind===undefined||window.kind===null?'':window.kind,usedPercent:window.usedPercent===undefined?null:window.usedPercent,resetsAt:window.resetsAt===undefined||window.resetsAt===null?'':window.resetsAt});
   }
   providers.push({provider:raw.provider===undefined||raw.provider===null?'':raw.provider,accountKey:raw.accountKey===undefined||raw.accountKey===null?'':raw.accountKey,updatedAt:raw.updatedAt===undefined||raw.updatedAt===null?'':raw.updatedAt,status:raw.status===undefined||raw.status===null?'':raw.status,stale:raw.stale===undefined?null:raw.stale,windows});
  }
  // parseBatch is reused for the allow-list/clock/size checks. A stream ID is
  // an internal connection identifier, so its actual format is restored below.
  const candidate={schemaVersion:1 as const,eventId:'0'.repeat(32),hubId,streamId:'a'.repeat(32),kind:event.name,observedAt:new Date(at).toISOString(),receivedAt:new Date(now).toISOString(),stats:{updatedAt:rawStats.updatedAt===undefined||rawStats.updatedAt===null?'':rawStats.updatedAt as string,periods:periodMap,devices,limits:{providers}}};
  const parsed=parseBatch({schemaVersion:1,events:[candidate]},[hubId],now).events[0];
  if(!parsed)throw new HubInputError('invalid Hub stats payload');
  const {schemaVersion:_schemaVersion,eventId:_eventId,...observation}=parsed;
  const result={...observation,streamId};
  if(new TextEncoder().encode(JSON.stringify(result)).length>128*1024)throw new HubInputError('compact event exceeds 128 KiB; reduce source scope');
  return result;
 }catch(error){if(error instanceof HubInputError)throw error;throw new HubInputError('invalid Hub stats payload');}
}

// Normalize dates before SQL lexical comparisons. Reject unknown event shape, not missing metrics.
export function parseBatch(input: unknown, allowedHubs: string[], now=Date.now()): Batch {
 if(!obj(input)||input.schemaVersion!==1||!Array.isArray(input.events)||input.events.length<1||input.events.length>2)throw new Error('expected schemaVersion=1 and 1..2 events');
 const events: TransportObservation[]=[];const seen=new Set<string>();
 for(const o of input.events){
  if(!obj(o)||o.schemaVersion!==1||!str(o.hubId,64)||!allowedHubs.includes(o.hubId)||!str(o.eventId,32)||!/^[a-f0-9]{32}$/.test(o.eventId)||!str(o.streamId,32)||!/^[a-f0-9]{32}$/.test(o.streamId)||!['snapshot','stats'].includes(o.kind as string)||!date(o.observedAt)||!date(o.receivedAt)||!stats(o.stats))throw new Error('invalid observation');
  if(Date.parse(o.observedAt)>now+300000||Date.parse(o.receivedAt)>now+300000)throw new Error('clock too far ahead');
  const key=o.hubId+':'+o.eventId;if(seen.has(key))throw new Error('duplicate event in batch');seen.add(key);
  if(new TextEncoder().encode(JSON.stringify(o)).length>128*1024)throw new Error('event over 128 KiB');
  const s=o.stats;const clean:Stats={updatedAt:s.updatedAt,periods:copyPeriods(s.periods),devices:s.devices.map(d=>({deviceId:d.deviceId,updatedAt:d.updatedAt,stale:d.stale,periods:copyPeriods(d.periods)})),limits:{providers:s.limits.providers.map(p=>({provider:p.provider,accountKey:p.accountKey,updatedAt:p.updatedAt,status:p.status,stale:p.stale,windows:p.windows.map(w=>({kind:w.kind,usedPercent:w.usedPercent,resetsAt:w.resetsAt}))}))}};
  events.push({schemaVersion:1,hubId:o.hubId,eventId:o.eventId,streamId:o.streamId,kind:o.kind as 'snapshot'|'stats',observedAt:new Date(o.observedAt).toISOString(),receivedAt:new Date(o.receivedAt).toISOString(),stats:clean});
 }
 return {schemaVersion:1,events};
}
export async function readLimited(request: Request, limit=270000): Promise<unknown>{
 if(!request.body)throw new Error('missing body');const reader=request.body.getReader();const chunks:Uint8Array[]=[];let n=0;
 try{for(;;){const r=await reader.read();if(r.done)break;n+=r.value.length;if(n>limit){await reader.cancel();throw new Error('body too large');}chunks.push(r.value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(n);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
