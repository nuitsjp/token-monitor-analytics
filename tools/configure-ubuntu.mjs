import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {destination,infrastructureFile,validateInfrastructure,assertInfrastructureFile} from './ubuntu-layout.mjs';
import {readJSON} from './publish-config.mjs';
import {configureApplication} from './configure-application.mjs';
import {userEnvironment,tailnetIdentity,privateText,inherit,report} from './ubuntu-common.mjs';
async function main(){
 userEnvironment();
 let values;try{({values}=parseArgs({options:{port:{type:'string'},'hub-url':{type:'string'},'hub-id':{type:'string',default:'hub-a'},'hub-secret':{type:'string'},'hub-secret-file':{type:'string'},'hubs-file':{type:'string'},locked:{type:'boolean'}},strict:true}));}catch{throw new Error('Invalid configuration arguments; check option names and required values.');}
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
 const old=fs.existsSync(`${destination}/connection.json`)?readJSON(`${destination}/connection.json`):null;
 const result=configureApplication({dir:destination,identity:tailnetIdentity(),port:Number(values.port??old?.port??8788),hubs});
 console.log(result.changed?'Private configuration saved.':'SKIP: configuration already matches.');
 if(!result.ready)throw new Error('Network and viewer credentials are ready, but Hub input is missing. Rerun configure:ubuntu -- --hub-url HTTPS_ORIGIN --hub-secret SECRET (or --hub-secret-file PRIVATE_FILE). No app was published.');
 console.log(`Configuration ready for ${result.publicOrigin}; not published yet. Viewer credentials are in ${destination}/analytics.env (0600).`);
}
main().catch(report);
