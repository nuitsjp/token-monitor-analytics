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
async function refresh(){dirty=true;if(loading)return;loading=true;try{do{dirty=false;data=await get('/api/state');notice(data.demo?'DEMO：合成データです。実サービスの料金・利用枠ではありません。':'');draw();if(view==='history')await loadHistory();}while(dirty);}catch(e){notice(e.message);}finally{loading=false;}}
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
function connection(s,on=false){$('live').textContent=s;$('dot').classList.toggle('on',on);}
function connect(){
 if(stopped||feed)return;
 const current=new EventSource('/api/live');feed=current;
 current.onopen=()=>connection('ライブ接続中',true);
 current.addEventListener('ready',()=>refresh());
 current.addEventListener('updated',()=>refresh());
 current.onerror=()=>connection('ライブ再接続待ち');
}
$('refresh').onclick=refresh;$('hub-select').onchange=draw;$('contract-select').onchange=()=>loadHistory().catch(e=>notice(e.message));
for(const b of document.querySelectorAll('nav button'))b.onclick=()=>{view=b.dataset.view;for(const t of document.querySelectorAll('nav button'))t.removeAttribute('aria-current');b.setAttribute('aria-current','page');for(const s of document.querySelectorAll('.view'))s.hidden=s.id!==view;$('title').textContent=b.textContent;if(view==='history')loadHistory().catch(e=>notice(e.message));};
document.addEventListener('visibilitychange',()=>{if(!document.hidden){refresh();connect();}});window.addEventListener('pagehide',()=>{stopped=true;feed?.close();feed=null;});
window.addEventListener('pageshow',()=>{stopped=false;refresh();connect();});
refresh();connect();
