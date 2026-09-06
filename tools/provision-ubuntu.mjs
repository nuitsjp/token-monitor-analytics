import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {readJSON,writeChanged} from './publish-config.mjs';
import {prefix,destination,appUnits,infrastructureFile,userUnit,unitDigest} from './ubuntu-layout.mjs';
import {run,inherit,report} from './ubuntu-common.mjs';
const systemctl=(...args)=>run('/usr/bin/systemctl',args);
function noLink(p){try{if(fs.lstatSync(p).isSymbolicLink())throw new Error('Managed paths must not be symlinks.');}catch(e){if(e.code!=='ENOENT')throw e;}}
function directory(p,uid,gid,mode){
 noLink(p);if(fs.existsSync(p)&&fs.statSync(p).uid!==uid&&fs.readdirSync(p).some(n=>!(p===prefix&&n==='.publish.lock'&&fs.lstatSync(path.join(p,n)).isFile()&&fs.statSync(path.join(p,n)).uid===uid)))throw new Error('Existing directory ownership requires an explicit migration.');
 fs.mkdirSync(p,{recursive:true,mode});if((fs.statSync(p).mode&0o777)!==mode)fs.chmodSync(p,mode);
 if(fs.statSync(p).uid!==uid||fs.statSync(p).gid!==gid)fs.chownSync(p,uid,gid);
}
async function main(){
 const {values}=parseArgs({options:{user:{type:'string'},apply:{type:'boolean'},locked:{type:'boolean'}},strict:true});
 if(process.platform!=='linux')throw new Error('Provisioning requires Ubuntu/systemd.');
 const username=values.user??process.env.TMA_DEPLOY_USER??process.env.SUDO_USER??process.env.USER;
 if(!/^[a-z_][a-z0-9_-]*$/.test(username??'')||username==='root')throw new Error('Set TMA_DEPLOY_USER to an existing ordinary publication user.');
 if(!values.apply){
  const args=[process.execPath,'--experimental-strip-types',fileURLToPath(import.meta.url),'--apply','--user',username];
  if(process.getuid()===0)inherit(args[0],args.slice(1));else inherit('/usr/bin/sudo',args);return;
 }
 if(process.getuid()!==0)throw new Error('Only provisioning requires root.');
 const passwd=run('/usr/bin/getent',['passwd',username]).trim().split(':');
 const uid=Number(passwd[2]),gid=Number(passwd[3]),home=passwd[5];
 if(!Number.isInteger(uid)||uid<1000||!home?.startsWith('/'))throw new Error('An existing ordinary user is required.');
 if(fs.existsSync(infrastructureFile)&&readJSON(infrastructureFile).uid!==uid)throw new Error('Changing publication user requires explicit migration.');
 if(!values.locked){
  // Stable, root-owned lock directory; all tasks share its publisher-owned file.
  const lockDir='/var/lib/tma-lock';noLink(lockDir);fs.mkdirSync(lockDir,{recursive:true,mode:0o755});
  const lock=`${lockDir}/deploy.lock`;noLink(lock);
  if(!fs.existsSync(lock))fs.closeSync(fs.openSync(lock,'wx',0o600));fs.chownSync(lock,uid,gid);
  inherit('/usr/bin/flock',['--nonblock','--conflict-exit-code','75',lock,process.execPath,'--experimental-strip-types',fileURLToPath(import.meta.url),'--apply','--locked','--user',username],{lock:true});return;
 }
 for(const unit of appUnits)if(systemctl('show','--property=LoadState','--value',unit).trim()!=='not-found')throw new Error('Legacy system application units require explicit migration; they were not stopped.');
 const required=['build-essential','curl','ca-certificates','tar'];
 const missing=required.filter(p=>spawnSync('/usr/bin/dpkg-query',['-W','-f=${Status}',p],{encoding:'utf8'}).stdout?.trim()!=='install ok installed');
 if(missing.length){run('/usr/bin/apt-get',['update']);run('/usr/bin/apt-get',['install','-y',...missing],{env:{...process.env,DEBIAN_FRONTEND:'noninteractive'}});}else console.log('SKIP: OS dependencies installed.');
 if(!fs.existsSync('/usr/bin/tailscale')){
  const installer=run('/usr/bin/curl',['--fail','--silent','--show-error','https://tailscale.com/install.sh']);
  run('/bin/sh',[],{input:installer});
 }else console.log('SKIP: Tailscale installed; existing connection and Serve settings retained.');
 systemctl('enable','--now','tailscaled.service');
 for(const p of [prefix,`${prefix}/releases`,'/var/lib/tma-deploy',destination,'/var/lib/tma-analytics','/var/lib/tma-analytics/backups','/var/lib/tma-collector','/var/lib/tma-collector/outbox'])directory(p,uid,gid,p.startsWith('/var/')?0o700:0o755);
 const userDir=path.join(home,'.config/systemd/user');
 for(const p of [path.join(home,'.config'),path.join(home,'.config/systemd'),userDir]){noLink(p);if(!fs.existsSync(p))directory(p,uid,gid,0o700);}
 let changed=false;
 for(const name of appUnits){const target=path.join(userDir,name);noLink(target);changed=writeChanged(target,userUnit(name))||changed;fs.chownSync(target,uid,gid);}
 if(spawnSync('/usr/bin/loginctl',['show-user',username,'-p','Linger','--value'],{encoding:'utf8'}).stdout?.trim()!=='yes')run('/usr/bin/loginctl',['enable-linger',username]);
 systemctl('start',`user@${uid}.service`);
 const userctl=(...args)=>run('/usr/sbin/runuser',['-u',username,'--','/usr/bin/env',`XDG_RUNTIME_DIR=/run/user/${uid}`,`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,'/usr/bin/systemctl','--user',...args]);
 if(changed)userctl('daemon-reload');
 for(const name of appUnits)userctl('enable',name);
 noLink(path.dirname(infrastructureFile));fs.mkdirSync(path.dirname(infrastructureFile),{recursive:true,mode:0o755});noLink(infrastructureFile);
 writeChanged(infrastructureFile,JSON.stringify({version:2,uid,username,unitDigest:unitDigest()},null,2)+'\n',0o644);
 console.log('Environment provisioned. Run configure:ubuntu and publish:ubuntu as the publication user.');
 const state=JSON.parse(run('/usr/bin/tailscale',['status','--json']));
 if(state.BackendState!=='Running')console.log('Tailscale login is still required: run sudo tailscale up in your terminal before configure:ubuntu.');
}
main().catch(report);
