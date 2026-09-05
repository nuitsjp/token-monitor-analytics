export interface Period { costUsd: number | null; totalTokens?: number | null; clientCosts?: Record<string, number | null> }
export interface Device { deviceId: string; updatedAt: string; stale: boolean | null; periods: Record<string, Period> }
export interface LimitWindow { kind: string; usedPercent: number | null; resetsAt: string }
export interface Provider {provider: string; accountKey: string; updatedAt: string; status: string; stale: boolean | null; windows: LimitWindow[]}
export interface Stats {updatedAt: string; periods: Record<string, Period>; devices: Device[]; limits: {providers: Provider[]}}
export interface Observation {schemaVersion: 1; hubId: string; eventId: string; streamId: string; kind: 'snapshot'|'stats'; observedAt: string; receivedAt: string; stats: Stats}
export interface Batch {schemaVersion: 1; events: Observation[]}
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
// Normalize dates before SQL lexical comparisons. Reject unknown event shape, not missing metrics.
export function parseBatch(input: unknown, allowedHubs: string[], now=Date.now()): Batch {
 if(!obj(input)||input.schemaVersion!==1||!Array.isArray(input.events)||input.events.length<1||input.events.length>2)throw new Error('expected schemaVersion=1 and 1..2 events');
 const events: Observation[]=[];const seen=new Set<string>();
 for(const o of input.events){
  if(!obj(o)||o.schemaVersion!==1||!str(o.hubId,64)||!allowedHubs.includes(o.hubId)||!str(o.eventId,32)||!/^[a-f0-9]{32}$/.test(o.eventId)||!str(o.streamId,32)||!/^[a-f0-9]{32}$/.test(o.streamId)||!['snapshot','stats'].includes(o.kind as string)||!date(o.observedAt)||!date(o.receivedAt)||!stats(o.stats))throw new Error('invalid observation');
  if(Date.parse(o.observedAt)>now+300000||Date.parse(o.receivedAt)>now+300000)throw new Error('clock too far ahead');
  const key=o.hubId+':'+o.eventId;if(seen.has(key))throw new Error('duplicate event in batch');seen.add(key);
  if(new TextEncoder().encode(JSON.stringify(o)).length>128*1024)throw new Error('event over 128 KiB');
  const s=o.stats;
  const copyPeriod=(p:Period):Period=>({costUsd:p.costUsd,...(p.totalTokens!==undefined?{totalTokens:p.totalTokens}:{}),...(p.clientCosts?{clientCosts:{...p.clientCosts}}:{})});
  const copyPeriods=(ps:Record<string,Period>)=>Object.fromEntries(Object.entries(ps).map(([k,p])=>[k,copyPeriod(p)]));
  const clean:Stats={updatedAt:s.updatedAt,periods:copyPeriods(s.periods),devices:s.devices.map(d=>({deviceId:d.deviceId,updatedAt:d.updatedAt,stale:d.stale,periods:copyPeriods(d.periods)})),limits:{providers:s.limits.providers.map(p=>({provider:p.provider,accountKey:p.accountKey,updatedAt:p.updatedAt,status:p.status,stale:p.stale,windows:p.windows.map(w=>({kind:w.kind,usedPercent:w.usedPercent,resetsAt:w.resetsAt}))}))}};
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
