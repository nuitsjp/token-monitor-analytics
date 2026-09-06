const $=id=>document.getElementById(id);
const money=n=>typeof n==='number'&&Number.isFinite(n)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n):'—';
let displayZone='Asia/Tokyo';
const when=t=>t?new Date(t).toLocaleString('ja-JP',{timeZone:displayZone,hour12:false}):'—';
const reasons={estimate_out_of_range:'推定値が計算範囲外',baseline_started:'基準値を観測',stream_reconnected:'再接続後の観測中',window_reset:'リセット後の観測中',observation_gap:'観測が途切れました',counter_decreased:'カウンター補正・減少',insufficient_change:'利用率の増分待ち',cost_did_not_increase:'利用額の増分待ち',attribution_unconfirmed:'契約の帰属未確認',account_missing_or_ambiguous:'アカウント未特定',limits_unavailable_or_stale:'利用率が取得不可・古い',window_missing_or_ambiguous:'制限枠を特定できません',window_invalid_or_expired:'制限枠が無効・期限切れ',device_missing_or_stale:'端末情報が不足・古い',cost_missing:'利用額の取得なし',source_time_mismatch:'観測時刻が一致しません',observed_delta:'同一期間の観測増分',out_of_order:'時刻が逆転'};
const status=s=>({estimated:'参考推定',observing:'観測中',unavailable:'推定不可'}[s]??s);
function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function notice(s){$('notice').textContent=s;$('notice').hidden=!s;}
async function get(path){const r=await fetch(path,{cache:'no-store'});if(r.status===401)throw new Error('閲覧認証が必要です。画面を再読み込みし、設定したユーザー名・パスワードでログインしてください。');if(!r.ok)throw new Error(`APIの読み込みに失敗しました (${r.status})。保存済みの表示は更新されていません。`);return r.json();}
let data=null,view='dashboard',feed=null,stopped=false,loading=false,dirty=false;
function options(select,entries){const old=select.value;select.replaceChildren(...entries.map(([value,text])=>{const e=el('option',text);e.value=value;return e;}));if(entries.some(x=>x[0]===old))select.value=old;}
function draw(){if(!data)return;displayZone=data.timeZone??'Asia/Tokyo';
 options($('hub-select'),data.configuredHubs.map(h=>[h.id,h.label]));
 options($('contract-select'),data.contracts.map(c=>[c.id,c.label]));
 const h=data.hubs.find(h=>h.hubId===$('hub-select').value),p=h?.stats.periods;
 $('today').textContent=money(p?.today?.costUsd);$('month').textContent=money(p?.month?.costUsd);$('alltime').textContent=money(p?.allTime?.costUsd);
 const age=h?Math.floor((Date.now()-Date.parse(h.observedAt))/60000):0;
 $('observed').textContent=h?`最終観測 ${when(h.observedAt)} ${displayZone}${age>=5?` · ${age}分前の観測値`:''}`:'まだ観測データがありません。Collectorのログと接続設定を確認してください。';
 $('estimates').replaceChildren();
 const cs=data.contracts.filter(c=>c.hubId===$('hub-select').value);
 if(!cs.length)$('estimates').append(el('div','契約の紐付けは未設定です。利用額の収集はこのまま継続できます。','empty'));
 for(const c of cs){const r=data.estimates.find(e=>e.contractId===c.id);const card=el('article',undefined,'estimate-card');card.append(el('h3',c.label),el('span',r?status(r.status):'観測待ち',`badge ${r?.status==='estimated'?'':'warn'}`),el('strong',money(r?.monthlyCapacityUsd)),el('p',`月間換算・参考値 / ${c.windowKind} 枠を換算`),el('p',r?`${reasons[r.reason]??r.reason} · 期間枠 ${money(r.windowCapacityUsd)}`:'対象アカウントの最初の観測を待っています。'));$('estimates').append(card);}
 $('limits').replaceChildren();for(const a of h?.stats.limits.providers??[]){for(const w of a.windows){const tr=el('tr');const name=el('td',a.provider);name.append(el('small',a.accountKey.slice(0,18)));const used=el('td',w.usedPercent===null?'—':`${w.usedPercent.toFixed(1)}%`);if(w.usedPercent!==null){const bar=el('div',undefined,'bar'),fill=el('i');fill.style.width=`${Math.max(0,Math.min(100,w.usedPercent))}%`;bar.append(fill);used.append(bar);}tr.append(name,el('td',w.kind),used,el('td',when(w.resetsAt)),el('td',a.stale===true?'古い観測値':a.status));$('limits').append(tr);}}
 if(!$('limits').children.length){const tr=el('tr'),td=el('td','利用率はまだ届いていません。');td.colSpan=5;tr.append(td);$('limits').append(tr);}
 $('connections').replaceChildren();for(const h of data.configuredHubs){const o=data.hubs.find(x=>x.hubId===h.id);const card=el('div',undefined,'callout');card.append(el('strong',`${h.label} / ${h.id}`),el('p',o?`最後の観測: ${when(o.observedAt)} ${displayZone}`:'未受信'));if(o){const details=el('details'),summary=el('summary','紐付け用の識別子');details.append(summary);for(const d of o.stats.devices){details.append(el('p',`deviceId: ${d.deviceId} / clients: ${Object.keys(d.periods.allTime?.clientCosts??{}).join(', ')}`));}for(const p of o.stats.limits.providers){details.append(el('p',`${p.provider} / accountKey: ${p.accountKey}`));}card.append(details);}$('connections').append(card);}
}
async function refresh(){dirty=true;if(loading)return;loading=true;try{do{dirty=false;data=await get('/api/state');notice(data.demo?'DEMO：合成データです。実サービスの料金・利用枠ではありません。':'');$('nav-manage').hidden=!data.management?.enabled;$('nav-update').hidden=!data.management?.enabled;draw();if(view==='history')await loadHistory();if(view==='manage')await loadManage();if(view==='update')await loadUpdate();}while(dirty);}catch(e){notice(e.message);}finally{loading=false;}}
async function loadHistory(){const id=$('contract-select').value;$('daily').replaceChildren();$('chart').replaceChildren();if(!id){$('chart').append(el('p','契約が未設定です。','muted'));return;}
 const result=await get(`/api/history?contract=${encodeURIComponent(id)}`);if($('contract-select').value!==id)return;
 for(const row of result.rows){const tr=el('tr');tr.append(el('td',row.day),el('td',money(row.monthly_capacity_usd)),el('td',money(row.window_capacity_usd)),el('td',when(row.last_valid_at)),el('td',`${status(row.status)} / ${reasons[row.reason]??row.reason}`));$('daily').append(tr);}
 chart(result.rows);}
function chart(rows){const valid=rows.filter(r=>r.monthly_capacity_usd!==null).reverse();if(!valid.length){$('chart').append(el('p','有効な推定が得られると、日次の月換算推移を表示します。','muted'));return;}
 const ns='http://www.w3.org/2000/svg';const make=(tag,attrs)=>{const e=document.createElementNS(ns,tag);for(const [k,v]of Object.entries(attrs))e.setAttribute(k,String(v));return e;};
 const svg=make('svg',{viewBox:'0 0 800 180',role:'img','aria-label':'月換算の参考推定値の日次推移。数値は下表を参照。'}),max=Math.max(1,...valid.map(r=>r.monthly_capacity_usd))*1.1;
 const start=Date.parse(valid[0].day),span=Math.max(86400000,Date.parse(valid.at(-1).day)-start);let segment=[],lastDay=0;
 const flush=()=>{if(segment.length>1)svg.append(make('polyline',{points:segment.join(' ')}));segment=[];};
 for(const r of valid){const day=Date.parse(r.day),x=valid.length===1?400:70+(day-start)/span*680,y=150-r.monthly_capacity_usd/max*125;if(lastDay&&day-lastDay>86400000)flush();segment.push(`${x},${y}`);svg.append(make('circle',{cx:x,cy:y,r:3}));lastDay=day;}flush();
 for(const [text,x,y]of (valid.length===1?[[money(max),0,24],['$0',0,154],[valid[0].day,365,177],[money(valid[0].monthly_capacity_usd),415,Math.max(18,145-valid[0].monthly_capacity_usd/max*125)]]:[[money(max),0,24],['$0',0,154],[valid[0].day,70,177],[valid.at(-1).day,680,177]])){const t=make('text',{x,y});t.textContent=text;svg.append(t);}$('chart').append(svg);}

let manageData=null;
async function post(path,body,method='POST'){
 const r=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 const json=await r.json().catch(()=>({}));
 if(!r.ok){const err=new Error(json.message||json.error||`Request failed (${r.status})`);err.status=r.status;err.data=json;throw err;}
 return json;
}
async function loadManage(){
 try{
  manageData=await get('/api/manage/hubs');
  drawManage();
 }catch(e){notice(e.message);}
}
function drawManage(){
 if(!manageData)return;
 const {revision,hubs,collector}=manageData;
 $('manage-status').replaceChildren();
 $('manage-status').append(el('span',`保存済み: rev ${revision}`));
 if(!collector||collector.status==='unknown'){
  $('manage-status').append(el('span','Collector状態不明','badge warn'));
 }else if(collector.appliedRevision<revision){
  $('manage-status').append(el('span',`反映待ち (要求 rev ${revision} / 適用 rev ${collector.appliedRevision})`,'badge sync'));
 }else{
  $('manage-status').append(el('span',`設定反映済み (rev ${revision})`,'badge active'));
 }
 if(collector?.lastReportAt){
  $('manage-status').append(el('small',`最終報告: ${when(collector.lastReportAt)}`,'muted'));
 }

 if(!hubs.length){
  $('manage-empty').hidden=false;
  $('manage-table-wrap').hidden=true;
  return;
 }
 $('manage-empty').hidden=true;
 $('manage-table-wrap').hidden=false;
 $('manage-hubs-body').replaceChildren();

 for(const h of hubs){
  const tr=el('tr');
  const nameTd=el('td');
  nameTd.append(el('strong',h.label),el('small',h.id));
  const urlTd=el('td',h.url);
  const statusTd=el('td');
  statusTd.append(el('span',h.status==='active'?'有効':'停止',`badge ${h.status==='active'?'active':'disabled'}`));

  const applied=collector?.appliedRevision>=revision;
  const syncTd=el('td');
  syncTd.append(el('span',applied?'反映済み':'反映待ち',`badge ${applied?'active':'sync'}`));

  const cHub=collector?.hubs?.[h.id];
  const connTd=el('td');
  let connLabel='不明',connCls='disabled';
  if(h.status==='disabled'){
   connLabel='停止中';connCls='disabled';
  }else if(cHub){
   if(cHub.status==='connected'){connLabel='接続中';connCls='active';}
   else if(cHub.status==='connecting'){connLabel='接続試行中';connCls='sync';}
   else if(cHub.status==='error'){connLabel=cHub.errorCode?`エラー (${cHub.errorCode})`:'エラー';connCls='error';}
   else if(cHub.status==='disabled'){connLabel='停止中';connCls='disabled';}
  }
  connTd.append(el('span',connLabel,`badge ${connCls}`));

  const actTd=el('td');
  const actWrap=el('div',undefined,'table-actions');
  const editBtn=el('button','編集','outline');
  editBtn.onclick=()=>openEditDialog(h);
  const toggleBtn=el('button',h.status==='active'?'停止':'有効化','outline');
  toggleBtn.onclick=()=>toggleHubStatus(h);
  const delBtn=el('button','削除','outline danger');
  delBtn.onclick=()=>openDeleteDialog(h);
  actWrap.append(editBtn,toggleBtn,delBtn);
  actTd.append(actWrap);

  tr.append(nameTd,urlTd,statusTd,syncTd,connTd,actTd);
  $('manage-hubs-body').append(tr);
 }
}

let dialogMode='add',editingHub=null;
function openAddDialog(){
 dialogMode='add';editingHub=null;
 $('dialog-title').textContent='Hubを追加';
 $('dialog-error').hidden=true;
 $('input-hub-id').value='';$('input-hub-id').readOnly=false;
 $('input-hub-label').value='';
 $('input-hub-url').value='';
 $('input-hub-secret').value='';$('input-hub-secret').required=true;
 $('status-group').hidden=true;
 $('secret-replace-group').hidden=true;
 $('secret-input-group').hidden=false;
 $('hub-dialog').showModal();
}
function openEditDialog(h){
 dialogMode='edit';editingHub=h;
 $('dialog-title').textContent=`Hubの編集: ${h.label}`;
 $('dialog-error').hidden=true;
 $('input-hub-id').value=h.id;$('input-hub-id').readOnly=true;
 $('input-hub-label').value=h.label;
 $('input-hub-url').value=h.url;
 $('select-hub-status').value=h.status;
 $('status-group').hidden=false;
 $('secret-replace-group').hidden=false;
 $('check-replace-secret').checked=false;
 $('input-hub-secret').value='';$('input-hub-secret').required=false;
 $('secret-input-group').hidden=true;
 $('hub-dialog').showModal();
}
$('check-replace-secret').onchange=()=>{
 $('secret-input-group').hidden=!$('check-replace-secret').checked;
 $('input-hub-secret').required=$('check-replace-secret').checked;
};
$('btn-add-hub').onclick=openAddDialog;
$('btn-dialog-cancel').onclick=()=>$('hub-dialog').close();
$('hub-form').onsubmit=async e=>{
 e.preventDefault();
 $('dialog-error').hidden=true;
 try{
  if(dialogMode==='add'){
   await post('/api/manage/hubs',{
    expectedRevision:manageData.revision,
    id:$('input-hub-id').value.trim(),
    label:$('input-hub-label').value.trim(),
    url:$('input-hub-url').value.trim(),
    secret:$('input-hub-secret').value
   });
  }else{
   const body={
    expectedRevision:manageData.revision,
    label:$('input-hub-label').value.trim(),
    url:$('input-hub-url').value.trim(),
    status:$('select-hub-status').value
   };
   if($('check-replace-secret').checked&&$('input-hub-secret').value){
    body.secret=$('input-hub-secret').value;
   }
   await post(`/api/manage/hubs/${encodeURIComponent(editingHub.id)}`,body,'PUT');
  }
  $('hub-dialog').close();
  await loadManage();
 }catch(err){
  $('dialog-error').textContent=err.status===409?'他の変更と競合しました。最新の情報を再読み込みしてください。':err.message;
  $('dialog-error').hidden=false;
 }
};

let deletingHub=null;
function openDeleteDialog(h){
 deletingHub=h;
 $('del-hub-name').textContent=`${h.label} (${h.id})`;
 $('delete-dialog-error').hidden=true;
 $('hub-delete-dialog').showModal();
}
$('btn-del-cancel').onclick=()=>$('hub-delete-dialog').close();
$('hub-delete-form').onsubmit=async e=>{
 e.preventDefault();
 $('delete-dialog-error').hidden=true;
 try{
  await post(`/api/manage/hubs/${encodeURIComponent(deletingHub.id)}`,{expectedRevision:manageData.revision},'DELETE');
  $('hub-delete-dialog').close();
  await loadManage();
 }catch(err){
  $('delete-dialog-error').textContent=err.data?.error==='hub_referenced_by_contract'?'契約が参照しているため削除できません。停止をご利用ください。':err.message;
  $('delete-dialog-error').hidden=false;
 }
};
async function toggleHubStatus(h){
 try{
  await post(`/api/manage/hubs/${encodeURIComponent(h.id)}`,{
   expectedRevision:manageData.revision,
   status:h.status==='active'?'disabled':'active'
  },'PUT');
  await loadManage();
 }catch(err){notice(err.message);}
}

let updateData=null,pollingRestart=false;
const updateErrors={lock_conflict:'他の発行タスクまたは更新処理が実行中です。',fetch_failed:'mainブランチの最新コミット取得に失敗しました。ネットワーク接続を確認してください。',commit_not_found:'指定されたコミットがリモートのmainに見つかりません。',verification_failed:'新バージョンのローカル検証（テストまたはビルド）に失敗したため、適用を中止しました。現在のバージョンは維持されています。',deploy_failed:'成果物の配置またはSQLiteバックアップに失敗しました。',health_check_failed:'新バージョンの起動または疎通確認に失敗しました。ホストログを確認してください。',job_aborted:'更新処理が途中で中断されました（プロセス終了またはサービス停止）。',system_restarted:'OS再起動により更新処理が中断されました。',save_state_failed:'状態ファイルの保存に失敗しました。',unknown_error:'予期せぬエラーが発生しました。'};
const stageNames={accepted:'受付済み',fetching:'取得中',verifying:'検証中',deploying:'配置中',restarting:'再起動中',success:'成功',failed:'失敗',aborted:'中断・状態不明'};

async function loadUpdate(){
 try{
  updateData=await get('/api/manage/update');
  drawUpdate();
 }catch(e){notice(e.message);}
}

function drawUpdate(){
 if(!updateData)return;
 const {supported,enabled,reason,current,candidate,job}=updateData;
 const banner=$('update-unsupported-banner');
 if(!supported||!enabled){
  let msg='この環境ではWeb UIからのシステム更新機能は利用できません。';
  if(reason==='unsupported_platform')msg='Windows開発環境ではWeb UIからのシステム更新は無効です（Ubuntu本番環境専用）。';
  else if(reason==='demo_mode')msg='デモ環境ではシステム更新は無効です。';
  else if(reason==='update_disabled')msg='設定ファイルでシステム更新機能（update.enabled）が無効化されています。';
  banner.textContent=msg;banner.hidden=false;
  $('btn-check-update').disabled=true;$('btn-apply-update').disabled=true;
 }else{
  banner.hidden=true;$('btn-check-update').disabled=false;
 }
 $('current-commit').textContent=current?.commitSha?`${current.commitSha.slice(0,12)} (${current.commitSha})`:'不明（推測しません）';
 $('current-commit-date').textContent=current?.commitDate?when(current.commitDate):'—';
 $('current-release-id').textContent=current?.releaseId?current.releaseId.slice(0,12):'—';

 const badge=$('candidate-badge'),applyBtn=$('btn-apply-update'),compLink=$('candidate-compare-link');
 if(!candidate){
  badge.textContent='未確認';badge.className='badge';
  $('candidate-commit').textContent='—';$('candidate-date').textContent='—';
  $('candidate-message').textContent='—';$('candidate-checked-at').textContent='未確認（「更新を確認」を押してください）';
  compLink.hidden=true;applyBtn.disabled=true;
 }else{
  $('candidate-commit').textContent=candidate.targetCommitSha.slice(0,12);
  $('candidate-date').textContent=candidate.commitDate?when(candidate.commitDate):'—';
  $('candidate-message').textContent=candidate.message||'—';
  $('candidate-checked-at').textContent=when(candidate.lastCheckedAt);
  if(candidate.compareUrl){compLink.href=candidate.compareUrl;compLink.hidden=false;}
  else{compLink.hidden=true;}
  if(candidate.hasUpdate){
   badge.textContent='新しいバージョンがあります';badge.className='badge warn';
   applyBtn.disabled=!supported||!enabled||(job&&job.status==='running');
  }else{
   badge.textContent='最新です';badge.className='badge active';
   applyBtn.disabled=true;
  }
 }

 const stageBadge=$('job-stage-badge'),jobErr=$('job-error'),jobRecovery=$('job-recovery');
 if(!job){
  $('job-id').textContent='—';stageBadge.textContent='待機中';stageBadge.className='badge';
  $('job-started-at').textContent='';$('job-finished-at').textContent='';
  jobErr.hidden=true;jobRecovery.hidden=true;
 }else{
  $('job-id').textContent=job.jobId;
  stageBadge.textContent=stageNames[job.stage]||job.stage;
  stageBadge.className=`badge stage-${job.stage}`;
  $('job-started-at').textContent=`開始: ${when(job.startedAt)}`;
  $('job-finished-at').textContent=job.finishedAt?`終了: ${when(job.finishedAt)}`:'';
  if(job.errorCode){
   jobErr.textContent=updateErrors[job.errorCode]||`エラーコード: ${job.errorCode}`;
   jobErr.hidden=false;
  }else{
   jobErr.hidden=true;
  }
  if(job.stage==='failed'&&(job.errorCode==='health_check_failed'||job.errorCode==='deploy_failed')){
   jobRecovery.hidden=false;
  }else{
   jobRecovery.hidden=true;
  }
  if(job.status==='running'&&!pollingRestart){
   applyBtn.disabled=true;
  }
 }
}

$('btn-check-update').onclick=async()=>{
 $('btn-check-update').disabled=true;
 $('btn-check-update').textContent='確認中...';
 try{
  await post('/api/manage/update/check',{});
  await loadUpdate();
 }catch(e){notice(e.message);}
 finally{
  $('btn-check-update').textContent='更新を確認';
  if(updateData?.supported&&updateData?.enabled)$('btn-check-update').disabled=false;
 }
};

$('btn-apply-update').onclick=()=>{
 if(!updateData?.candidate)return;
 $('dialog-target-commit').textContent=updateData.candidate.targetCommitSha.slice(0,12);
 $('update-confirm-dialog').showModal();
};
$('btn-update-cancel').onclick=()=>$('update-confirm-dialog').close();
$('update-confirm-form').onsubmit=async e=>{
 e.preventDefault();
 $('update-confirm-dialog').close();
 if(!updateData?.candidate)return;
 try{
  await post('/api/manage/update/apply',{targetCommitSha:updateData.candidate.targetCommitSha});
  await loadUpdate();
  waitForRestart();
 }catch(err){notice(err.message);}
};

function waitForRestart(){
 if(pollingRestart)return;
 pollingRestart=true;
 $('update-restarting-overlay').hidden=false;
 let attempts=0;
 const maxAttempts=90;
 const timer=setInterval(async()=>{
  attempts++;
  try{
   const res=await fetch('/api/health',{cache:'no-store',signal:AbortSignal.timeout(1500)});
   if(res.ok){
    clearInterval(timer);
    pollingRestart=false;
    $('update-restarting-overlay').hidden=true;
    await refresh();
    if(view==='update')await loadUpdate();
    return;
   }
  }catch{}
  if(attempts>=maxAttempts){
   clearInterval(timer);
   $('restarting-text').textContent='再起動が完了しませんでした。SSHでホストに接続し、サービス状態を確認してください。';
  }
 },2000);
}

function connection(s,on=false){$('live').textContent=s;$('dot').classList.toggle('on',on);}
function connect(){
 if(stopped||feed)return;
 const current=new EventSource('/api/live');feed=current;
 current.onopen=()=>connection('ライブ接続中',true);
 current.addEventListener('ready',()=>refresh());
 current.addEventListener('updated',()=>refresh());
 current.addEventListener('manage_updated',()=>refresh());
 current.addEventListener('update_candidate_updated',()=>loadUpdate());
 current.addEventListener('update_job_changed',()=>loadUpdate());
 current.onerror=()=>{
  connection('ライブ再接続待ち');
  if(updateData?.job?.status==='running')waitForRestart();
 };
}
$('refresh').onclick=refresh;$('hub-select').onchange=draw;$('contract-select').onchange=()=>loadHistory().catch(e=>notice(e.message));
for(const b of document.querySelectorAll('nav button'))b.onclick=()=>{view=b.dataset.view;for(const t of document.querySelectorAll('nav button'))t.removeAttribute('aria-current');b.setAttribute('aria-current','page');for(const s of document.querySelectorAll('.view'))s.hidden=s.id!==view;$('title').textContent=b.textContent;if(view==='history')loadHistory().catch(e=>notice(e.message));if(view==='manage')loadManage().catch(e=>notice(e.message));if(view==='update')loadUpdate().catch(e=>notice(e.message));};
document.addEventListener('visibilitychange',()=>{if(!document.hidden){refresh();connect();}});window.addEventListener('pagehide',()=>{stopped=true;feed?.close();feed=null;});
window.addEventListener('pageshow',()=>{stopped=false;refresh();connect();});
refresh();connect();

