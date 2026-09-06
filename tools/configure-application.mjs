import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {readJSON,readEnvironment,writeChanged} from './publish-config.mjs';
import {readHubsConfig} from '../analytics/runtime/hubs.mjs';
import {isTailnetIPv4} from '../analytics/runtime/config.mjs';
function envText(env){return Object.entries(env).map(([key,value])=>{
 if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||typeof value!=='string'||/[\r\n\0]/.test(value))throw new Error('Invalid environment assignment.');
 const quote=value.includes("'")?'"':"'";
 if(value.includes(quote)||(quote==='"'&&value.includes('\\')))throw new Error('Secret contains unsupported quote/escape characters.');
 return `${key}=${quote}${value}${quote}`;
}).join('\n')+'\n';}
function configureLegacyApplication({dir,identity,port=8788,hubs}){
 if(!isTailnetIPv4(identity.tailnetIP)||!/^[-a-z0-9.]+\.ts\.net$/.test(identity.hostname)||!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid Tailscale identity or port.');
 const file=name=>path.join(dir,name),json=name=>fs.existsSync(file(name))?readJSON(file(name)):null;
 const env=name=>fs.existsSync(file(name))?readEnvironment(file(name)):{};
 const aEnv=env('analytics.env'),cEnv=env('collector.env');
 if(aEnv.TMA_INGEST_TOKEN&&cEnv.TMA_INGEST_TOKEN&&aEnv.TMA_INGEST_TOKEN!==cEnv.TMA_INGEST_TOKEN)throw new Error('Existing ingest credentials disagree; no settings were changed.');
 const token=aEnv.TMA_INGEST_TOKEN??cEnv.TMA_INGEST_TOKEN??randomBytes(32).toString('hex');
 aEnv.TMA_INGEST_TOKEN=token;cEnv.TMA_INGEST_TOKEN=token;
 aEnv.TMA_VIEWER_USER??='viewer';aEnv.TMA_VIEWER_PASSWORD??=randomBytes(24).toString('hex');
 const oldA=json('analytics.json'),oldC=json('collector.json');
 if(oldA&&(oldA.ingestTokenEnv!=='TMA_INGEST_TOKEN'||(oldA.viewerAuth.mode==='basic'&&(oldA.viewerAuth.userEnv!=='TMA_VIEWER_USER'||oldA.viewerAuth.passwordEnv!=='TMA_VIEWER_PASSWORD'))))throw new Error('Existing custom credential names require explicit migration.');
 let configuredHubs=oldC?.hubs;
 if(hubs){
  if(!Array.isArray(hubs)||hubs.length<1||hubs.length>8)throw new Error('Configure 1..8 real Hubs.');
  const ids=new Set(),urls=new Set();
  configuredHubs=hubs.map((h,index)=>{
   let u;try{u=new URL(h.url);}catch{throw new Error('Invalid Hub URL.');}
   if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(h.id)||ids.has(h.id)||urls.has(u.origin)||u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||typeof h.secret!=='string'||!h.secret||/[\r\n\0]/.test(h.secret)||h.secret.startsWith('REPLACE_')||h.secret==='demo-hub-secret'||h.secret===token||h.secret===aEnv.TMA_VIEWER_PASSWORD)throw new Error('Hub IDs, HTTPS URLs and independent secrets must be valid.');
   ids.add(h.id);urls.add(u.origin);const key=`TMA_HUB_${index+1}_SECRET`;cEnv[key]=h.secret;
   return {id:h.id,url:u.origin,secret_env:key};
  });
 }
 const plan={version:2,...identity,port,publicOrigin:`http://${identity.hostname}:${port}`};
 const outputs=[['analytics.env',envText(aEnv)],['collector.env',envText(cEnv)],['connection.json',JSON.stringify(plan,null,2)+'\n']];
 if(configuredHubs?.length){
  const analytics={version:1,listen:{host:'127.0.0.1',port},publicOrigin:plan.publicOrigin,databasePath:'/var/lib/tma-analytics/analytics.db',timeZone:'Asia/Tokyo',detailRetentionDays:7,ingestTokenEnv:'TMA_INGEST_TOKEN',viewerAuth:{mode:'basic',userEnv:'TMA_VIEWER_USER',passwordEnv:'TMA_VIEWER_PASSWORD'},contracts:[],...oldA,demo:false,tailnetViewer:{host:identity.tailnetIP,port}};
  analytics.viewerAuth={mode:'tailscale'};
  analytics.listen={host:'127.0.0.1',port};analytics.publicOrigin=plan.publicOrigin;
  analytics.hubs=configuredHubs.map(h=>({id:h.id,label:oldA?.hubs.find(a=>a.id===h.id)?.label??h.id}));
  if(analytics.contracts.some(c=>!configuredHubs.some(h=>h.id===c.hubId)))throw new Error('A removed Hub is still referenced by a contract; no configuration was changed.');
  const collector={version:1,ingest_token_env:'TMA_INGEST_TOKEN',spool_dir:'/var/lib/tma-collector/outbox',max_spool_bytes:268435456,flush_seconds:2,batch_size:2,idle_seconds:90,...oldC,analytics_url:`http://127.0.0.1:${port}`,hubs:configuredHubs};
  outputs.push(['analytics.json',JSON.stringify(analytics,null,2)+'\n'],['collector.json',JSON.stringify(collector,null,2)+'\n']);
 }
 let changed=false;
 for(const [name,text] of outputs)changed=writeChanged(file(name),text,0o600)||changed;
 return {ready:!!configuredHubs?.length,changed,publicOrigin:plan.publicOrigin};
}


export function configureApplication(options) {
 const {dir, identity, port=8788, hubs, management=false, resetHubs=false} = options;
 const file=name=>path.join(dir,name);
 const read=name=>fs.existsSync(file(name))?readJSON(file(name)):null;
 const oldA=read('analytics.json'),oldC=read('collector.json');
 const managed=management||resetHubs||!!oldA?.hubsPath||!!oldC?.hubs_path||(!oldA&&!oldC&&!hubs);
 if(!managed)return configureLegacyApplication(options);
 if(hubs)throw new Error('Managed Hub registration must use the UI; CLI Hub updates are disabled.');
 if(!isTailnetIPv4(identity.tailnetIP)||!/^[-a-z0-9.]+\.ts\.net$/.test(identity.hostname)||!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid Tailscale identity or port.');
 if((oldA?.hubs||oldC?.hubs)&&!resetHubs)throw new Error('Legacy Hub settings exist. Stop collection and use --reset-hubs to discard them explicitly.');
 if(resetHubs&&oldA?.contracts?.length)throw new Error('Contracts still reference existing Hubs; remove their configuration before resetting Hubs. History is retained.');
 if(oldA&&oldA.ingestTokenEnv!=='TMA_INGEST_TOKEN'||oldC&&oldC.ingest_token_env!=='TMA_INGEST_TOKEN')throw new Error('Custom ingest credential names require explicit configuration.');
 const aEnv=fs.existsSync(file('analytics.env'))?readEnvironment(file('analytics.env')):{};
 const cEnv=fs.existsSync(file('collector.env'))?readEnvironment(file('collector.env')):{};
 if(aEnv.TMA_INGEST_TOKEN&&cEnv.TMA_INGEST_TOKEN&&aEnv.TMA_INGEST_TOKEN!==cEnv.TMA_INGEST_TOKEN)throw new Error('Existing ingest credentials disagree.');
 const token=aEnv.TMA_INGEST_TOKEN??cEnv.TMA_INGEST_TOKEN??randomBytes(32).toString('hex');
 aEnv.TMA_INGEST_TOKEN=token;cEnv.TMA_INGEST_TOKEN=token;
 const hubsPath=oldA?.hubsPath??oldC?.hubs_path??'./hubs.json';
 const absHubs=path.resolve(dir,hubsPath);
 if(oldC?.hubs_path&&path.resolve(dir,oldC.hubs_path)!==absHubs)throw new Error('Managed Hub paths disagree.');
 const secretsPath='hub-secrets.json';
 // Initialization never replaces an existing managed store during ordinary configure.
 if(!resetHubs&&fs.existsSync(absHubs))readHubsConfig(absHubs);
 if(!resetHubs&&!fs.existsSync(absHubs)&&(oldA?.hubsPath||oldC?.hubs_path))throw new Error('Managed Hub store is missing; refusing to recreate it.');
 if(resetHubs){
  if(oldA?.hubsPath){
   const current=readHubsConfig(absHubs);
   if(current.secretsFilePath!==path.join(path.dirname(absHubs),secretsPath))throw new Error('Reset requires the standard secrets filename.');
  }
  for(const h of oldC?.hubs??[])if(h.secret_env&&h.secret_env!=='TMA_INGEST_TOKEN')delete cEnv[h.secret_env];
  for(const key of Object.keys(cEnv))if(/^TMA_HUB_/.test(key))delete cEnv[key];
 }
 const plan={version:2,...identity,port,publicOrigin:`http://${identity.hostname}:${port}`};
 const analytics={version:1,listen:{host:'127.0.0.1',port},publicOrigin:plan.publicOrigin,databasePath:'/var/lib/tma-analytics/analytics.db',timeZone:'Asia/Tokyo',detailRetentionDays:7,ingestTokenEnv:'TMA_INGEST_TOKEN',contracts:[],...oldA,demo:false,viewerAuth:{mode:'tailscale'},tailnetViewer:{host:identity.tailnetIP,port},hubsPath,management:{enabled:management||resetHubs||!oldA?true:Boolean(oldA.management?.enabled)}};
 delete analytics.hubs;
 analytics.listen={host:'127.0.0.1',port};analytics.publicOrigin=plan.publicOrigin;
 const collector={version:1,ingest_token_env:'TMA_INGEST_TOKEN',spool_dir:'/var/lib/tma-collector/outbox',max_spool_bytes:268435456,flush_seconds:2,batch_size:2,idle_seconds:90,...oldC,analytics_url:`http://127.0.0.1:${port}`,hubs_path:hubsPath};
 delete collector.hubs;
 let changed=false;
 const json=x=>JSON.stringify(x,null,2)+'\n';
 if(resetHubs||!fs.existsSync(absHubs)){
  changed=writeChanged(path.join(path.dirname(absHubs),secretsPath),json({schemaVersion:1,secrets:{}}),0o600)||changed;
  changed=writeChanged(absHubs,json({schemaVersion:1,revision:0,secretsPath,hubs:[]}),0o600)||changed;
 }
 for(const [name,value] of [['analytics.env',envText(aEnv)],['collector.env',envText(cEnv)],['analytics.json',json(analytics)],['collector.json',json(collector)],['connection.json',json(plan)]])changed=writeChanged(file(name),value,0o600)||changed;
 return {ready:true,changed,publicOrigin:plan.publicOrigin};
}
