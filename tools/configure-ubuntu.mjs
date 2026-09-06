import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {destination,infrastructureFile,validateInfrastructure,assertInfrastructureFile} from './ubuntu-layout.mjs';
import {drainOutbox} from './reset-hubs.mjs';
import {readJSON,readEnvironment} from './publish-config.mjs';
import {configureApplication} from './configure-application.mjs';
import {userEnvironment,tailnetIdentity,privateText,inherit,report,run} from './ubuntu-common.mjs';
async function main(){
 userEnvironment();
 let values;try{({values}=parseArgs({options:{management:{type:'boolean'},'reset-hubs':{type:'boolean'},port:{type:'string'},'hub-url':{type:'string'},'hub-id':{type:'string',default:'hub-a'},'hub-secret':{type:'string'},'hub-secret-file':{type:'string'},'hubs-file':{type:'string'},locked:{type:'boolean'}},strict:true}));}catch{throw new Error('Invalid configuration arguments; check option names and required values.');}
 if(values['hub-secret']!==undefined&&values['hub-secret-file']!==undefined)throw new Error('Choose either --hub-secret or --hub-secret-file.');
 if(values['hubs-file']&&(values['hub-url']||values['hub-secret']!==undefined||values['hub-secret-file']))throw new Error('Choose either --hubs-file or single-Hub options.');
 if(!fs.existsSync(infrastructureFile))throw new Error('Run provision:ubuntu first; it does not require Hub configuration.');
 assertInfrastructureFile();validateInfrastructure(readJSON(infrastructureFile),process.getuid());
 if(!values.locked){inherit('/usr/bin/flock',['-n','-E','75','/var/lib/tma-lock/deploy.lock',process.execPath,'--experimental-strip-types',fileURLToPath(import.meta.url),...process.argv.slice(2),'--locked'],{lock:true});return;}
 let hubs;
 if(values['hubs-file']){
  try{hubs=JSON.parse(privateText(values['hubs-file']));}catch{throw new Error('Cannot parse private Hub input; use an array of {id,url,secretFile}.');}
  if(!Array.isArray(hubs))throw new Error('Hub input must be an array.');
  hubs=hubs.map(h=>({id:h.id,url:h.url,secret:privateText(h.secretFile).replace(/\r?\n$/,'')}));
 }else if(values['hub-url']||values['hub-secret']!==undefined||values['hub-secret-file']){
  if(!values['hub-url']||(!values['hub-secret-file']&&values['hub-secret']===undefined))throw new Error('Provide --hub-url and either --hub-secret or --hub-secret-file.');
  hubs=[{id:values['hub-id'],url:values['hub-url'],secret:values['hub-secret']??privateText(values['hub-secret-file']).replace(/\r?\n$/,'')}];
 }
 if((values.management||values['reset-hubs'])&&hubs)throw new Error('Register Hubs in the UI after management initialization; do not combine CLI Hub input with reset.');
 if(values['reset-hubs']){
  const collectorFile=`${destination}/collector.json`;
  if(fs.existsSync(collectorFile)){
   const current=readJSON(collectorFile),a=readJSON(`${destination}/analytics.json`);
   if(a.contracts?.length)throw new Error('Remove Hub contract settings before reset; history will be retained.');
   run('/usr/bin/systemctl',['--user','stop','tma-collector.service']);
   const env=readEnvironment(`${destination}/collector.env`);
   const count=await drainOutbox({directory:current.spool_dir,origin:current.analytics_url,token:env[current.ingest_token_env]});
   console.log(`Saved ${count} pending observations before reset.`);
   run('/usr/bin/systemctl',['--user','stop','tma-analytics.service']);
  }
 }
 const old=fs.existsSync(`${destination}/connection.json`)?readJSON(`${destination}/connection.json`):null;
 const result=configureApplication({dir:destination,identity:tailnetIdentity(),port:Number(values.port??old?.port??8788),hubs,management:values.management,resetHubs:values['reset-hubs']});
 console.log(result.changed?'Private configuration saved.':'SKIP: configuration already matches.');
 if(!result.ready)throw new Error('Network and viewer credentials are ready, but Hub input is missing. Rerun configure:ubuntu -- --hub-url HTTPS_ORIGIN --hub-secret SECRET (or --hub-secret-file PRIVATE_FILE). No app was published.');
 if(values['reset-hubs'])console.log('Old Hub registrations and secrets removed. Services remain stopped; run mise run publish:ubuntu, then register Hubs in the UI.');
 console.log(`Configuration ready for ${result.publicOrigin}; not published yet. Viewer access uses the Tailscale boundary without an application password.`);
}
main().catch(report);
