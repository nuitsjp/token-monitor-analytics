import {validateHubUrl} from '../../src/hubs.ts';
import {HistoryInputError,historyRevisionFromSseData,normalizeHistoryResponse,parseHistoryResponse} from '../../src/history.ts';

export const MAX_HISTORY_BODY_BYTES = 16 << 20;
export const DEFAULT_HISTORY_HEADER_TIMEOUT_MS = 20_000;
export const DEFAULT_HISTORY_BODY_TIMEOUT_MS = 20_000;
export const MIN_HISTORY_FETCH_INTERVAL_MS = 5_000;
export const MAX_HISTORY_RETRIES = 3;

export class HistoryHTTPError extends Error {
  constructor(status) {
    super(`Hub History HTTP ${status}`);
    this.name='HistoryHTTPError';
    this.status=status;
    this.retriable=status===408||status===429||status>=500;
    this.unsupported=status===404||status===405||status===501;
  }
}

export class HistoryUnsupportedError extends Error {
  constructor(){super('Hub does not support /api/devices History');this.name='HistoryUnsupportedError';this.code='unsupported';this.permanent=true;}
}

export class HistoryTimeoutError extends Error {
  constructor(message='Hub History request timed out'){super(message);this.name='HistoryTimeoutError';this.code='network_error';}
}

function linkSignal(signal){
  const controller=new AbortController();
  if(!signal)return {signal:controller.signal,controller,detach(){}};
  if(signal.aborted)controller.abort(signal.reason);
  const onAbort=()=>controller.abort(signal.reason);
  if(!signal.aborted)signal.addEventListener('abort',onAbort,{once:true});
  return {signal:controller.signal,controller,detach:()=>signal.removeEventListener('abort',onAbort)};
}

function wait(ms,signal){
  if(ms<=0)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason||new Error('aborted'));return;}
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},ms);
    timer.unref?.();
    const onAbort=()=>{clearTimeout(timer);reject(signal.reason||new Error('aborted'));};
    signal?.addEventListener('abort',onAbort,{once:true});
  });
}

async function readBodyLimited(response,{signal,maxBytes=MAX_HISTORY_BODY_BYTES,timeoutMs=DEFAULT_HISTORY_BODY_TIMEOUT_MS}={}){
  if(!response.body)throw Object.assign(new Error('missing History response body'),{code:'network_error'});
  const reader=response.body.getReader();
  const chunks=[];let total=0;
  const linked=linkSignal(signal);
  const timer=setTimeout(()=>linked.controller.abort(new HistoryTimeoutError('Hub History body timeout')),timeoutMs);
  timer.unref?.();
  let onAbort;
  const aborted=new Promise((_,reject)=>{
    onAbort=()=>reject(linked.signal.reason||new HistoryTimeoutError());
    if(linked.signal.aborted)onAbort();
    else linked.signal.addEventListener('abort',onAbort,{once:true});
  });
  try{
    while(true){
      const result=await Promise.race([reader.read(),aborted]);
      if(result.done)break;
      const bytes=result.value;
      total+=bytes.byteLength;
      if(total>maxBytes){try{await reader.cancel();}catch{};throw Object.assign(new Error('History response exceeds body limit'),{code:'body_too_large',status:413});}
      chunks.push(bytes);
    }
  }catch(error){
    try{await reader.cancel(error);}catch{}
    if(linked.signal.aborted)throw linked.signal.reason||error;
    if(error?.code!=='body_too_large'&&!(error instanceof HistoryInputError)){
      throw Object.assign(error instanceof Error?error:new Error('History response body read failed'),{code:'network_error'});
    }
    throw error;
  }finally{
    clearTimeout(timer);linked.signal.removeEventListener('abort',onAbort);linked.controller.abort();linked.detach();
    try{reader.releaseLock();}catch{}
  }
  const bytes=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new HistoryInputError('invalid UTF-8 in History response');}
}

function mediaType(value){return typeof value==='string'?value.split(';',1)[0].trim().toLowerCase():'';}

function validSecret(secret){return typeof secret==='string'&&secret.length>0&&!/[\r\n\0]/.test(secret);}

/** Fetch and validate one complete authenticated `/api/devices` response. */
export async function fetchHistory({hub,signal,fetchImpl=globalThis.fetch,headerTimeoutMs=DEFAULT_HISTORY_HEADER_TIMEOUT_MS,bodyTimeoutMs=DEFAULT_HISTORY_BODY_TIMEOUT_MS,maxBodyBytes=MAX_HISTORY_BODY_BYTES}={}){
  let origin;
  try{origin=validateHubUrl(hub?.url);}catch{throw Object.assign(new Error('invalid Hub URL'),{code:'config_error',permanent:true});}
  if(!validSecret(hub?.secret))throw Object.assign(new Error('missing or invalid shared secret'),{code:'config_error',permanent:true});
  const linked=linkSignal(signal);
  const timeout=Number.isFinite(headerTimeoutMs)&&headerTimeoutMs>0?headerTimeoutMs:DEFAULT_HISTORY_HEADER_TIMEOUT_MS;
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;linked.controller.abort(new HistoryTimeoutError('Hub History header timeout'));},timeout);
  timer.unref?.();
  try{
    let response;
    try{
      response=await fetchImpl(`${origin}/api/devices`,{method:'GET',headers:{Authorization:`Bearer ${hub.secret}`,Accept:'application/json','Cache-Control':'no-cache'},redirect:'manual',signal:linked.signal});
    }catch(error){
      if(signal?.aborted)throw signal.reason||error;
      if(timedOut)throw new HistoryTimeoutError('Hub History header timeout');
      throw Object.assign(new Error('Hub History connection failed'),{code:'network_error'});
    }
    clearTimeout(timer);
    if(timedOut)throw new HistoryTimeoutError('Hub History header timeout');
    if(signal?.aborted)return null;
    if(response.status===404||response.status===405||response.status===501){try{await response.body?.cancel();}catch{};throw new HistoryUnsupportedError();}
    if(response.status!==200){try{await response.body?.cancel();}catch{};throw new HistoryHTTPError(response.status);}
    const type=response.headers?.get?.('content-type');
    if(mediaType(type)!=='application/json'){try{await response.body?.cancel();}catch{};throw new HistoryInputError('expected application/json from Hub History');}
    const declared=response.headers?.get?.('content-length');
    if(declared&&/^\d+$/.test(declared)&&Number(declared)>maxBodyBytes){try{await response.body?.cancel();}catch{};throw Object.assign(new Error('History response exceeds body limit'),{code:'body_too_large',status:413});}
    const text=await readBodyLimited(response,{signal:linked.signal,maxBytes:maxBodyBytes,timeoutMs:bodyTimeoutMs});
    return parseHistoryResponse(text);
  }finally{clearTimeout(timer);linked.controller.abort();linked.detach();}
}

function currentRevision(value){
  if(typeof value==='string'&&value.length>0&&value.length<=256)return value;
  if(typeof value==='number'&&Number.isSafeInteger(value))return String(value);
  return null;
}

function schedulerError(error){
  if(error?.code==='config_error')return 'config_error';
  if(error?.code==='storage_error'||error?.fatal===true)return 'storage_error';
  if(error?.code==='unsupported'||error instanceof HistoryUnsupportedError)return 'unsupported';
  if(error?.code==='history_input_error'||error instanceof HistoryInputError)return 'input_error';
  if(error?.code==='body_too_large'||error?.status===413)return 'response_too_large';
  if(error instanceof HistoryHTTPError&&(error.status===401||error.status===403))return 'auth_error';
  return 'network_error';
}

function retriable(error){return error?.retriable===true||error instanceof HistoryHTTPError&&error.retriable===true||error?.code==='network_error'||error instanceof HistoryTimeoutError;}

/**
 * Own one serialized History fetch pipeline per Hub.  A revision is only a
 * dirty notification: it is never written as the version of the GET response.
 * The response is useful only after complete validation and the caller's
 * commit; a newer notification observed meanwhile schedules one follow-up.
 */
export function createHistoryScheduler({
  onFetchStart,
  onSuccess,
  onFailure,
  onStatus,
  onFatal,
  fetchImpl,
  headerTimeoutMs,
  bodyTimeoutMs,
  maxBodyBytes=MAX_HISTORY_BODY_BYTES,
  minIntervalMs=MIN_HISTORY_FETCH_INTERVAL_MS,
  maxRetries=MAX_HISTORY_RETRIES,
  retryDelayMs=0,
  now=()=>Date.now(),
  sleep=wait,
}={}){
  const runners=new Map();
  // A start is a desired state transition. Keep each accepted transition
  // until it settles so stopHub/stop can wait for an operation that is still
  // retiring its predecessor, even after that predecessor left `runners`.
  const hubStates=new Map();
  let nextStartToken=1;
  let stopped=false;
  let stopPromise=null;

  const hubState=id=>{
    let state=hubStates.get(id);
    if(!state){
      state={desiredToken:0,tail:Promise.resolve(),pending:new Set(),retiring:new Set()};
      hubStates.set(id,state);
    }
    return state;
  };

  const safeWait=value=>Promise.resolve(value).catch(()=>{});

  const trackRetiring=(id,value)=>{
    const state=hubState(id);
    const completion=safeWait(value);
    state.retiring.add(completion);
    // The returned promise is already rejection-safe. Catch the promise
    // produced by finally as well, since cleanup must never create an
    // unhandled rejection while a caller is shutting down.
    completion.finally(()=>{state.retiring.delete(completion);}).catch(()=>{});
    return completion;
  };

  const publish=(runner,state,errorCode='',extra={})=>{
    runner.state=state;runner.errorCode=errorCode;runner.updatedAt=new Date(now()).toISOString();
    onStatus?.({hubId:runner.hub.id,state,errorCode,updatedAt:runner.updatedAt,lastFetchAt:runner.lastFetchAt||null,attempts:runner.attempts,...extra});
  };

  const isCurrent=runner=>runners.get(runner.hub.id)===runner&&!stopped&&!runner.controller.signal.aborted;

  const schedule=(runner,reason)=>{
    if(!isCurrent(runner)||runner.scheduled||runner.inFlight||!runner.pending)return;
    runner.pendingReason=reason||runner.pendingReason||'revision';
    const elapsed=now()-runner.lastStartAt;
    const delay=Math.max(0,minIntervalMs-elapsed);
    // Publish the completion promise before entering `run`. Callbacks from
    // its first status/fetch hook may synchronously stop or replace the Hub;
    // retirement must then wait for the complete invocation, not a missing
    // `runner.done` placeholder.
    const launch=()=>{
      runner.done=Promise.resolve().then(()=>{
        runner.scheduled=false;
        return run(runner);
      });
    };
    runner.scheduled=true;
    if(delay===0){
      launch();
      return;
    }
    runner.timer=setTimeout(()=>{runner.timer=null;launch();},delay);
    runner.timer.unref?.();
  };

  const asStorageError=error=>{
    if(error?.code==='storage_error'||error?.fatal===true)return error;
    return Object.assign(new Error('History persistence failed'),{code:'storage_error',fatal:true,cause:error});
  };

  const completeFailure=async(runner,error,attempts)=>{
    if(!isCurrent(runner))return;
    runner.attempts=attempts;runner.lastErrorCode=schedulerError(error);
    publish(runner,'error',runner.lastErrorCode,{attempts});
    try{
      await onFailure?.({hub:runner.hub,generation:runner.generation,fetchId:runner.fetchId,errorCode:runner.lastErrorCode,error,attempts});
    }catch(bookkeepingError){
      const fatal=asStorageError(bookkeepingError);
      publish(runner,'error','storage_error',{attempts});
      try{onFatal?.(fatal,runner.hub.id);}catch{}
      return;
    }
    if(error?.fatal===true||error?.code==='storage_error'){
      try{onFatal?.(error,runner.hub.id);}catch{}
    }
  };

  async function run(runner){
    if(!isCurrent(runner)||runner.inFlight||!runner.pending)return;
    const runId=runner.nextRunId++;
    runner.pending=false;runner.inFlight=true;runner.inFlightRunId=runId;runner.lastStartAt=now();runner.attempts=0;
    const reason=runner.pendingReason||'manual';runner.pendingReason='';
    const requestedRevision=runner.revision;
    const startedAt=new Date(runner.lastStartAt).toISOString();
    let fetchId=runner.nextRequestId++;
    runner.fetchId=fetchId;
    publish(runner,'fetching','',{reason});
    try{
      let allocated;
      try{
        allocated=await onFetchStart?.({hub:runner.hub,generation:runner.generation,requestId:fetchId,startedAt,reason});
      }catch(error){
        throw asStorageError(error);
      }
      if(Number.isSafeInteger(allocated)&&allocated>0)fetchId=allocated;
      runner.fetchId=fetchId;
      let response=null;let error=null;let attempts=0;
      for(attempts=1;attempts<=maxRetries+1;attempts++){
        if(!isCurrent(runner))return;
        const sinceAttempt=now()-runner.lastAttemptAt;
        if(sinceAttempt<minIntervalMs)await sleep(minIntervalMs-sinceAttempt,runner.controller.signal);
        runner.lastAttemptAt=now();
        try{
          response=await fetchHistory({hub:runner.hub,signal:runner.controller.signal,fetchImpl,headerTimeoutMs,bodyTimeoutMs,maxBodyBytes});
          error=null;break;
        }catch(candidate){
          error=candidate;
          if(!retriable(candidate)||attempts>maxRetries)break;
          if(retryDelayMs>0)await sleep(retryDelayMs,runner.controller.signal);
        }
      }
      runner.attempts=attempts;
      if(error){await completeFailure(runner,error,attempts);return;}
      if(response===null||!isCurrent(runner))return;
      const completedAt=new Date(now()).toISOString();
      // The revision seen when this request started is intentionally not part
      // of the success payload: SSE and GET are not an atomic version pair.
      try{
        await onSuccess?.({hub:runner.hub,generation:runner.generation,fetchId,requestId:runner.fetchId,startedAt,completedAt,response,attempts});
      }catch(error){
        throw asStorageError(error);
      }
      if(!isCurrent(runner))return;
      runner.lastFetchAt=completedAt;runner.lastErrorCode='';
      publish(runner,'success','',{attempts});
      if(runner.revision!==requestedRevision)runner.pending=true;
    }catch(error){
      if(isCurrent(runner)){
        await completeFailure(runner,error,runner.attempts||1);
      }else if(error?.fatal===true||error?.code==='storage_error'){
        // A persistence callback can settle after a replacement or shutdown
        // removed this runner. Its storage failure is still fatal; the
        // generation fence only suppresses stale network bookkeeping.
        try{onFatal?.(error,runner.hub.id);}catch{}
      }
    }finally{
      // `schedule` may start the next run synchronously. Clear this run's
      // ownership before doing so, and never write runner state after that
      // call; otherwise run N's finally can clear run N+1's inFlight flag.
      if(isCurrent(runner)&&runner.inFlightRunId===runId){
        const shouldSchedule=runner.pending&&!runner.scheduled;
        const nextReason=runner.pendingReason||(runner.dirty?'revision':'dirty');
        runner.inFlight=false;
        runner.inFlightRunId=null;
        runner.dirty=false;
        if(shouldSchedule)schedule(runner,nextReason);
      }
    }
  }

  async function startHub(hub,generation=0){
    const id=hub?.id;
    if(stopped)return null;
    const state=hubState(id);
    // Queued starts represent the latest desired generation: a newer request
    // supersedes an older one that has not begun, while an active generation
    // is still retired and awaited before the replacement starts.
    const token=nextStartToken++;
    state.desiredToken=token;
    const record={id,token,cancelled:false,promise:null};
    state.pending.add(record);
    const previous=state.tail;
    let operation;
    const raw=previous.catch(()=>{}).then(async()=>{
      if(stopped||record.cancelled||state.desiredToken!==token)return null;
      // This is the retirement requested by this start operation. It must
      // not call stopHub, which would invalidate this operation's own token.
      await retireCurrent(id);
      // An external stopHub may have removed the runner and left its save in
      // `retiring` already. Replacement must wait for that completion too;
      // otherwise it can fetch while the old generation is still committing.
      await Promise.all([...state.retiring].map(safeWait));
      if(stopped||record.cancelled||state.desiredToken!==token)return null;
      const runner={hub:{id:hub.id,url:hub.url,secret:hub.secret},generation,controller:new AbortController(),timer:null,scheduled:false,inFlight:false,inFlightRunId:null,nextRunId:1,pending:true,pendingReason:'startup',dirty:false,revision:null,lastStartAt:-Infinity,lastAttemptAt:-Infinity,lastFetchAt:null,nextRequestId:1,attempts:0,state:'idle',errorCode:'',updatedAt:new Date(now()).toISOString()};
      runners.set(hub.id,runner);publish(runner,'pending','',{reason:'startup'});schedule(runner,'startup');
      if(stopped||record.cancelled||state.desiredToken!==token||!isCurrent(runner))return null;
      return runner;
    });
    operation=raw.finally(()=>{
      state.pending.delete(record);
      if(state.tail===operation)state.tail=Promise.resolve();
    });
    record.promise=operation;
    state.tail=operation;
    return await operation;
  }

  function retireCurrent(id){
    const runner=runners.get(id);
    if(!runner)return Promise.resolve();
    if(runner.retirePromise)return runner.retirePromise;
    runners.delete(id);
    runner.retired=true;
    if(runner.timer)clearTimeout(runner.timer);
    runner.controller.abort();
    runner.retirePromise=trackRetiring(id,runner.done||Promise.resolve());
    return runner.retirePromise;
  }

  function cancelPendingStarts(id){
    const state=hubStates.get(id);
    if(!state)return [];
    state.desiredToken=nextStartToken++;
    const pending=[...state.pending];
    for(const record of pending)record.cancelled=true;
    return pending;
  }

  function stopHub(id){
    // Invalidate queued starts before the first await. A replacement may
    // already have removed its predecessor from `runners` while waiting for
    // that predecessor's persistence callback.
    const cancelled=cancelPendingStarts(id);
    const retirement=retireCurrent(id);
    const state=hubStates.get(id);
    const retiring=[...(state?.retiring||[])];
    return Promise.all([
      retirement,
      ...retiring,
      ...cancelled.map(record=>record.promise),
    ].map(safeWait)).then(()=>{});
  }

  function notifyRevision(id,value,generation){
    const runner=runners.get(id);if(!runner)return false;
    if(generation!==undefined&&generation!==runner.generation)return false;
    const revision=currentRevision(value);if(revision===null)return false;
    if(runner.revision===revision)return true;
    runner.revision=revision;runner.pending=true;runner.pendingReason='revision';
    if(!runner.inFlight)schedule(runner,'revision');
    else runner.dirty=true;
    return true;
  }

  function request(id,reason='manual'){
    const runner=runners.get(id);if(!runner)return false;
    runner.pending=true;runner.pendingReason=reason;
    if(runner.inFlight)runner.dirty=true;else schedule(runner,reason);
    return true;
  }

  function stop(){
    if(stopPromise)return stopPromise;
    stopped=true;
    const waits=[];
    for(const [id,state] of hubStates){
      state.desiredToken=nextStartToken++;
      const pending=[...state.pending];
      for(const record of pending)record.cancelled=true;
      waits.push(...pending.map(record=>record.promise));
      waits.push(...state.retiring);
      // A runner is removed and tracked synchronously, so the resulting
      // retirement promise is included in the same shutdown barrier.
      waits.push(retireCurrent(id));
    }
    for(const id of [...runners.keys()])waits.push(retireCurrent(id));
    stopPromise=Promise.all(waits.map(safeWait)).then(()=>{});
    return stopPromise;
  }
  function getStatus(){return [...runners.values()].map(r=>({hubId:r.hub.id,generation:r.generation,state:r.state,errorCode:r.errorCode,updatedAt:r.updatedAt,lastFetchAt:r.lastFetchAt,attempts:r.attempts}));}

  return {
    startHub,
    stopHub,
    stop,
    notifyRevision,
    request,
    getStatus,
  };
}

export {historyRevisionFromSseData,normalizeHistoryResponse};
