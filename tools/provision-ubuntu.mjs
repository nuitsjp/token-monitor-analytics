import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {readJSON,writeChanged} from './publish-config.mjs';
import {withPublicationLock} from './release.mjs';
import {
 prefix,releasesDir,destination,appUnits,managedUnits,legacySystemUnits,
 updaterDir,repoDir,infrastructureFile,deploymentLock,userUnit,unitDigest,updaterRunnerFiles,
 infrastructureVersion,configVersion,serviceContractVersion,runnerVersion,runtimeContract
} from './ubuntu-layout.mjs';
import {run,inherit,report} from './ubuntu-common.mjs';

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const systemctl=(...args)=>run('/usr/bin/systemctl',args);

// These are the only host packages the single-app publication/update path
// needs. Node itself is copied from the fixed runtime used to run provision;
// the old Go build and Tailscale installer are deliberately not part of this
// privileged bootstrap.
export const requiredPackages=Object.freeze(['ca-certificates','git','tar']);

function noLink(filename){
 try{
  if(fs.lstatSync(filename).isSymbolicLink())throw new Error('Managed paths must not be symlinks.');
 }catch(error){if(error?.code!=='ENOENT')throw error;}
}

export function ensureDirectory(filename,uid,gid,mode){
 noLink(filename);
 if(fs.existsSync(filename)){
  const stat=fs.lstatSync(filename);
  if(!stat.isDirectory())throw new Error(`Managed path is not a directory: ${filename}`);
  if(stat.uid!==uid&&fs.readdirSync(filename).length>0)throw new Error('Existing non-empty directory belongs to another owner; use the explicit migration procedure.');
 }
 fs.mkdirSync(filename,{recursive:true,mode});
 const stat=fs.statSync(filename);
 if(stat.uid!==uid||stat.gid!==gid)fs.chownSync(filename,uid,gid);
 if((stat.mode&0o777)!==mode)fs.chmodSync(filename,mode);
}

function userController(username,uid){
 return (...args)=>run('/usr/sbin/runuser',['-u',username,'--','/usr/bin/env',`XDG_RUNTIME_DIR=/run/user/${uid}`,`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,'/usr/bin/systemctl','--user',...args]);
}

function systemUnitLoadState(unit){
 const result=spawnSync('/usr/bin/systemctl',['show','--property=LoadState','--value',unit],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 if(result.error||result.status!==0)throw new Error('Cannot inspect the system service manager; provisioning stopped before changing files.');
 return result.stdout.trim()||'not-found';
}

/** Reject every known legacy system unit before the first provisioning mutation. */
export function assertLegacySystemUnitsAbsent(loadState=systemUnitLoadState){
 const loaded=[];
 for(const unit of legacySystemUnits){
  const state=loadState(unit);
  if(state!=='not-found')loaded.push(`${unit}=${state}`);
 }
 if(loaded.length)throw Object.assign(new Error('Legacy system services require the explicit migration procedure; they were not stopped.'),{code:'legacy_system_unit',units:loaded});
 return true;
}

function installRequiredPackages(){
 const missing=requiredPackages.filter(packageName=>spawnSync('/usr/bin/dpkg-query',['-W','-f=${Status}',packageName],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).stdout?.trim()!=='install ok installed');
 if(!missing.length){console.log('SKIP: required Node publication packages are installed.');return;}
 run('/usr/bin/apt-get',['update']);
 run('/usr/bin/apt-get',['install','-y',...missing],{env:{...process.env,DEBIAN_FRONTEND:'noninteractive'}});
}

function deploymentLockDirectory(){
 const directory=path.dirname(deploymentLock);
 noLink(directory);
 fs.mkdirSync(directory,{recursive:true,mode:0o755});
 const stat=fs.statSync(directory);
 if(!stat.isDirectory())throw new Error('Deployment lock parent is not a directory.');
 if((stat.mode&0o777)!==0o755)fs.chmodSync(directory,0o755);
}

async function provisionLocked({username,uid,gid,home}){
 const existing=fs.existsSync(infrastructureFile)?readJSON(infrastructureFile):null;
 if(existing&&existing.uid!==uid)throw new Error('Changing publication user requires explicit migration.');
 installRequiredPackages();
 const directories=[
  [prefix,0o755],[releasesDir,0o755],['/var/lib/tma-deploy',0o700],[destination,0o700],
  ['/var/lib/tma-analytics',0o700],['/var/lib/tma-analytics/backups',0o700],[updaterDir,0o700],[repoDir,0o700]
 ];
 for(const [directory,mode] of directories)ensureDirectory(directory,uid,gid,mode);
 const updaterNode=path.join(updaterDir,'node');
 noLink(updaterNode);
 fs.copyFileSync(process.execPath,updaterNode);fs.chmodSync(updaterNode,0o755);fs.chownSync(updaterNode,uid,gid);
 for(const relative of updaterRunnerFiles){
  const source=path.join(sourceRoot,relative),target=path.join(updaterDir,relative);
  if(!fs.lstatSync(source).isFile())throw new Error(`Updater dependency is missing: ${relative}`);
  fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o755});
  noLink(target);
  fs.copyFileSync(source,target);fs.chmodSync(target,0o755);fs.chownSync(target,uid,gid);
 }
 const userUnits=path.join(home,'.config/systemd/user');
 ensureDirectory(path.join(home,'.config'),uid,gid,0o700);
 ensureDirectory(path.join(home,'.config/systemd'),uid,gid,0o700);
 ensureDirectory(userUnits,uid,gid,0o700);
 let changed=false;
 for(const unit of managedUnits){
  const filename=path.join(userUnits,unit);
  noLink(filename);
  changed=writeChanged(filename,userUnit(unit),0o644)||changed;
  fs.chownSync(filename,uid,gid);
 }
 if(spawnSync('/usr/bin/loginctl',['show-user',username,'-p','Linger','--value'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).stdout?.trim()!=='yes')run('/usr/bin/loginctl',['enable-linger',username]);
 // Starting the user manager is needed for daemon-reload/enable, but the
 // application itself is only enabled below. The oneshot update unit is never
 // enabled or started by provisioning.
 systemctl('start',`user@${uid}.service`);
 const userctl=userController(username,uid);
 if(changed)userctl('daemon-reload');
 for(const unit of appUnits)userctl('enable',unit);
 noLink(path.dirname(infrastructureFile));
 fs.mkdirSync(path.dirname(infrastructureFile),{recursive:true,mode:0o755});
 noLink(infrastructureFile);
 const record={
  version:infrastructureVersion,uid,username,configVersion,serviceContractVersion,runnerVersion,
  appUnits:[...appUnits],managedUnits:[...managedUnits],unitDigest:unitDigest(),runtimeContract:runtimeContract()
 };
 writeChanged(infrastructureFile,`${JSON.stringify(record,null,2)}\n`,0o644);
 console.log('Environment provisioned. Run configure:ubuntu and publish:ubuntu as the publication user.');
}

export async function main(argv=process.argv.slice(2)){
 const {values}=parseArgs({args:argv,options:{user:{type:'string'},apply:{type:'boolean'}},strict:true});
 if(process.platform!=='linux')throw new Error('Provisioning requires Ubuntu/systemd.');
 const username=values.user??process.env.TMA_DEPLOY_USER??process.env.SUDO_USER??process.env.USER;
 if(!/^[a-z_][a-z0-9_-]*$/.test(username??'')||username==='root')throw new Error('Set TMA_DEPLOY_USER to an existing ordinary publication user.');
 if(!values.apply){
  const args=[process.execPath,'--experimental-strip-types',fileURLToPath(import.meta.url),'--apply','--user',username];
  if(process.getuid?.()===0)inherit(args[0],args.slice(1));else inherit('/usr/bin/sudo',args);
  return;
 }
 if(process.getuid?.()!==0)throw new Error('Only provisioning requires root.');
 const passwd=run('/usr/bin/getent',['passwd',username]).trim().split(':');
 const uid=Number(passwd[2]),gid=Number(passwd[3]),home=passwd[5];
 if(!Number.isInteger(uid)||uid<1000||!home?.startsWith('/'))throw new Error('An existing ordinary user is required.');
  // This read-only preflight must happen before lock creation, package
  // installation, ownership changes, unit writes, or user-manager startup.
  assertLegacySystemUnitsAbsent();
  deploymentLockDirectory();
  noLink(deploymentLock);
  await withPublicationLock(deploymentLock,async()=>{
  noLink(deploymentLock);
  fs.chownSync(deploymentLock,uid,gid);
  await provisionLocked({username,uid,gid,home});
 });
}

const isMain=process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]);
if(isMain)main().catch(report);
