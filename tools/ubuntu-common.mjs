import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {isTailnetIPv4} from '../analytics/runtime/config.mjs';
export function run(command,args,options={}){
 try{return execFileSync(command,args,{encoding:'utf8',stdio:'pipe',...options});}
 catch{throw new Error(`${path.basename(command)} failed; inspect host configuration locally (sensitive output suppressed).`);}
}
export function inherit(command,args,{lock=false}={}){
 const r=spawnSync(command,args,{stdio:'inherit'});
 if(r.error)throw new Error(`Cannot start ${path.basename(command)}.`);
 if(r.status!==0){
  if(lock&&r.status===75)throw new Error('Another environment/configuration/publication task holds the deployment lock.');
  throw Object.assign(new Error(),{reported:true,exitCode:r.status??1});
 }
}
export function report(error){if(!error.reported)console.error(error.code||error instanceof SyntaxError?'Required host file or permission is missing; run status:ubuntu for prerequisites.':error.message);process.exitCode=error.exitCode??1;}
export function userEnvironment(){
 if(process.platform!=='linux'||process.getuid()===0)throw new Error('Run this task as the configured ordinary Ubuntu user, without sudo.');
 process.env.XDG_RUNTIME_DIR??=`/run/user/${process.getuid()}`;
 process.env.DBUS_SESSION_BUS_ADDRESS??=`unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;
}
export function tailnetIdentity(){
 let state;try{state=JSON.parse(run('/usr/bin/tailscale',['status','--json']));}catch{throw new Error('Tailscale is unavailable; run provision:ubuntu.');}
 const ip=state.Self?.TailscaleIPs?.find(isTailnetIPv4),hostname=state.Self?.DNSName?.replace(/\.$/,'');
 if(state.BackendState!=='Running'||!ip||!hostname||!hostname.endsWith('.ts.net'))throw new Error('Tailscale is not connected. Complete tailscale up, then retry.');
 return {tailnetIP:ip,hostname};
}
export function privateText(file){
 const s=fs.lstatSync(file);
 if(!s.isFile()||(s.mode&0o077))throw new Error('Private input must be a regular file with mode 0600.');
 return fs.readFileSync(file,'utf8');
}
