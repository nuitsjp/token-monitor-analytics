import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {credentials,loadConfig} from '../analytics/runtime/config.mjs';

export const destination='/var/lib/tma-deploy/config';
export function readJSON(filename){
 let text;
 try{text=fs.readFileSync(filename,'utf8');}
 catch(error){
  const target=JSON.stringify(path.resolve(filename));
  if(error.code==='ENOENT')throw Object.assign(new Error(`Deployment JSON not found: ${target}`),{missingFile:true});
  if(['EACCES','EPERM'].includes(error.code))throw Object.assign(new Error(`Permission denied reading deployment JSON: ${target}`),{needsRootRead:true});
  throw new Error(`Cannot read deployment JSON file: ${target}`);
 }
 try{return JSON.parse(text.replace(/^\uFEFF/,''));}
 catch{throw new Error(`Invalid JSON syntax in ${JSON.stringify(path.resolve(filename))}; inspect the file locally. File contents are not displayed.`);}
}
// A deliberately small subset shared by systemd EnvironmentFile and this reader.
// Never source a shell file or interpolate secrets into a command.
export function readEnvironment(filename){
 const stat=fs.statSync(filename);
 if(process.platform!=='win32'&&(stat.mode&0o077))throw new Error('Environment files must have mode 0600 (or stricter).');
 const env=Object.create(null);
 for(const line of fs.readFileSync(filename,'utf8').split(/\r?\n/)){
  if(!line.trim()||line.startsWith('#'))continue;
  const match=/^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"\\\r\n\0]*)"|'([^'\r\n\0]*)'|([^\s'"\\\r\n\0]+))$/.exec(line);
  if(!match||Object.hasOwn(env,match[1]))throw new Error('Invalid/duplicate environment assignment; use one KEY=value per line, optionally quoted, without escapes.');
  env[match[1]]=match[2]??match[3]??match[4];
 }
 return env;
}
export function selectConfiguration(plan,dir=destination){
 return Object.fromEntries(Object.entries({analyticsConfig:'analytics.json',collectorConfig:'collector.json',analyticsEnv:'analytics.env',collectorEnv:'collector.env'}).map(([key,name])=>{
  const target=path.join(dir,name);
  return [key,fs.existsSync(target)?target:plan[key]];
 }));
}
export function validateConfiguration(plan,selected){
 const analytics=loadConfig(selected.analyticsConfig),collector=readJSON(selected.collectorConfig);
 const analyticsEnv=readEnvironment(selected.analyticsEnv),collectorEnv=readEnvironment(selected.collectorEnv);
 if(readJSON(selected.analyticsConfig).databasePath!=='/var/lib/tma-analytics/analytics.db'||!analytics.tailnetViewer||analytics.tailnetViewer.host!==plan.tailnetIP||analytics.tailnetViewer.port!==plan.port)throw new Error('Use the absolute production DB path and matching tailnet viewer settings.');
 if(analytics.demo||!['basic','tailscale'].includes(analytics.viewerAuth.mode)||analytics.listen.host!=='127.0.0.1'||analytics.publicOrigin!==plan.publicOrigin||analytics.databasePath!=='/var/lib/tma-analytics/analytics.db'){
  throw new Error('Publication requires REAL mode, basic/tailscale viewer, 127.0.0.1, matching HTTP tailnet origin and /var/lib/tma-analytics/analytics.db.');
 }
 const auth=credentials(analytics,analyticsEnv);
 if(collector.analytics_url!==`http://127.0.0.1:${analytics.listen.port}`||collector.spool_dir!=='/var/lib/tma-collector/outbox'||collectorEnv[collector.ingest_token_env]!==auth.ingest){
  throw new Error('Collector loopback URL, persistent outbox path or ingest credential does not match Analytics.');
 }
 if(!Array.isArray(collector.hubs)||collector.hubs.length!==analytics.hubs.length||collector.hubs.some(h=>!analytics.hubs.some(a=>a.id===h.id)))throw new Error('Analytics and Collector Hub IDs must match.');
 for(const hub of collector.hubs){
  let url;try{url=new URL(hub.url);}catch{throw new Error('Invalid Hub URL.');}
  const secret=collectorEnv[hub.secret_env];
  if(url.protocol!=='https:'||!secret||secret.startsWith('REPLACE_')||secret==='demo-hub-secret'||secret===auth.ingest||secret===auth.password){
   throw new Error('Real Hub HTTPS URL and independent, non-placeholder Hub secret are required.');
  }
 }
 return {analytics,collector,analyticsEnv,collectorEnv,auth};
}
export function writeChanged(filename,bytes,mode=0o644){
 const content=Buffer.from(bytes);
 if(fs.existsSync(filename)&&fs.readFileSync(filename).equals(content)){fs.chmodSync(filename,mode);return false;}
 const temp=`${filename}.tmp-${process.pid}`;
 try{fs.writeFileSync(temp,content,{mode,flag:'wx'});fs.renameSync(temp,filename);fs.chmodSync(filename,mode);}
 finally{fs.rmSync(temp,{force:true});}
 return true;
}

// Archive timestamps do not define a release. Rebuilding identical files is a no-op.
export function treeDigest(directory){
 const hash=createHash('sha256');
 function walk(base,relative=''){
  for(const name of fs.readdirSync(base).sort()){
   const filename=path.join(base,name),entry=relative+name,stat=fs.lstatSync(filename);
   if(stat.isDirectory())walk(filename,entry+'/');
   else if(stat.isFile()){
    const bytes=fs.readFileSync(filename);
    hash.update(JSON.stringify([entry,stat.mode&0o111,bytes.length]));hash.update(bytes);
   }else throw new Error('Release must contain only regular files and directories.');
  }
 }
 walk(directory);return hash.digest('hex');
}
