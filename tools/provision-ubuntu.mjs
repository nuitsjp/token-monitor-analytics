import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {readJSON,writeChanged,assertOldLayout} from './publish-config.mjs';
import {withPublicationLock} from './release.mjs';
import {
 prefix,releasesDir,destination,appUnits,managedUnits,legacySystemUnits,
 updaterDir,runtimeBinDir,repoDir,infrastructureFile,deploymentLock,userUnit,unitDigest,updaterRunnerFiles,
 infrastructureVersion,configVersion,serviceContractVersion,runnerVersion,runtimeContract,assertInfrastructureFile
} from './ubuntu-layout.mjs';
import {run,inherit,report} from './ubuntu-common.mjs';

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const systemctl=(...args)=>run('/usr/bin/systemctl',args);

// These are the only host packages the single-app publication/update path
// needs. Node itself is copied from the fixed runtime used to run provision;
// the old Go build dependencies are not needed. curl is retained solely for
// the idempotent Tailscale package bootstrap below.
export const requiredPackages=Object.freeze(['ca-certificates','curl','git','tar']);

function noLink(filename){
 try{
  if(fs.lstatSync(filename).isSymbolicLink())throw new Error('Managed paths must not be symlinks.');
 }catch(error){if(error?.code!=='ENOENT')throw error;}
}

function pathExists(filename){
 try{fs.lstatSync(filename);return true;}
 catch(error){if(error?.code==='ENOENT')return false;throw error;}
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

export function bootstrapTailscale({exists=filename=>fs.existsSync(filename),runCommand=run,systemctlCommand=systemctl}={}){
 if(!exists('/usr/bin/tailscale')){
  const installer=runCommand('/usr/bin/curl',['--fail','--silent','--show-error','https://tailscale.com/install.sh']);
  runCommand('/bin/sh',[],{input:installer});
 }else console.log('SKIP: Tailscale is installed; existing login and Serve settings are retained.');
 systemctlCommand('enable','--now','tailscaled.service');
 try{
  const state=JSON.parse(runCommand('/usr/bin/tailscale',['status','--json']));
  if(state.BackendState!=='Running')console.log('Tailscale login is still required: run sudo tailscale up in your terminal before configure:ubuntu.');
 }catch{
  console.log('Tailscale login is still required: run sudo tailscale up in your terminal before configure:ubuntu.');
 }
}

function systemUnitLoadState(unit){
 const result=spawnSync('/usr/bin/systemctl',['show','--property=LoadState','--value',unit],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 if(result.error||result.status!==0)throw new Error('Cannot inspect the system service manager; provisioning stopped before changing files.');
 return result.stdout.trim()||'not-found';
}

function userUnitLoadState(username,uid,unit){
 const result=spawnSync('/usr/sbin/runuser',['-u',username,'--','/usr/bin/env',`XDG_RUNTIME_DIR=/run/user/${uid}`,`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,'/usr/bin/systemctl','--user','show','--property=LoadState','--value',unit],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 // A user manager may not exist yet on a fresh host. The filesystem check in
 // assertLegacyUserUnitsAbsent still catches a legacy unit file in that case.
 if(result.error||result.status!==0)return 'not-found';
 return result.stdout.trim()||'not-found';
}

/** Recognize the one-app layout even when its service/runner digest is old. */
export function isIntegratedInfrastructureRecord(record,uid){
 return record?.version===infrastructureVersion&&record.uid===uid&&record.configVersion===configVersion&&
  Array.isArray(record.appUnits)&&JSON.stringify(record.appUnits)===JSON.stringify(appUnits)&&
  Array.isArray(record.managedUnits)&&JSON.stringify(record.managedUnits)===JSON.stringify(managedUnits)&&
  Number.isSafeInteger(record.serviceContractVersion)&&record.serviceContractVersion>=0&&
  Number.isSafeInteger(record.runnerVersion)&&record.runnerVersion>=0&&
  typeof record.unitDigest==='string'&&/^[0-9a-f]{64}$/i.test(record.unitDigest);
}

function integratedInfrastructure(uid){
 try{
  assertInfrastructureFile(infrastructureFile);
  return isIntegratedInfrastructureRecord(readJSON(infrastructureFile),uid);
 }catch{return false;}
}

/** Check the complete current service/runner requirements separately. */
function currentInfrastructure(uid){
 try{
  assertInfrastructureFile(infrastructureFile);
  const record=readJSON(infrastructureFile);
  return isIntegratedInfrastructureRecord(record,uid)&&record.serviceContractVersion===serviceContractVersion&&record.runnerVersion===runnerVersion&&record.unitDigest===unitDigest();
 }catch{return false;}
}

/** Reject legacy user-systemd units/files without creating or changing paths. */
export function assertLegacyUserUnitsAbsent({home,loadState=()=> 'not-found',hasCurrentInfrastructure=()=>false}={}){
 if(typeof home!=='string'||!home)throw new Error('A user home directory is required for the legacy unit preflight.');
 const unitDirectory=path.join(home,'.config','systemd','user');
 const collectorFile=path.join(unitDirectory,'tma-collector.service');
 const analyticsFile=path.join(unitDirectory,'tma-analytics.service');
 const collectorLoaded=loadState('tma-collector.service');
 if(pathExists(collectorFile)||collectorLoaded!=='not-found')throw Object.assign(new Error('Legacy user Collector services require the explicit migration procedure; they were not stopped.'),{code:'legacy_user_unit',unit:'tma-collector.service'});
 const analyticsLoaded=loadState('tma-analytics.service');
 if((pathExists(analyticsFile)||analyticsLoaded!=='not-found')&&!hasCurrentInfrastructure())throw Object.assign(new Error('A legacy user Analytics service requires the explicit migration procedure; it was not stopped.'),{code:'legacy_user_unit',unit:'tma-analytics.service'});
 return true;
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
 if(!fs.existsSync(directory))fs.mkdirSync(directory,{recursive:true,mode:0o755});
 const stat=fs.lstatSync(directory);
 if(!stat.isDirectory())throw new Error('Deployment lock parent is not a directory.');
 if(stat.uid!==0&&fs.readdirSync(directory).length>0)throw new Error('Existing non-empty deployment lock directory belongs to another owner; use the explicit migration procedure.');
 if(stat.uid!==0)fs.chownSync(directory,0,0);
 if((stat.mode&0o777)!==0o755)fs.chmodSync(directory,0o755);
}

function regularRuntimeFile(filename,label){
 const stat=fs.lstatSync(filename);
 if(!stat.isFile()||stat.isSymbolicLink())throw new Error(`${label} must be a regular file: ${filename}`);
 return filename;
}

function fixedNpmPackage(nodeFilename){
 const node=fs.realpathSync(nodeFilename);
 const installation=path.dirname(path.dirname(node));
 const candidates=[
  path.join(installation,'lib','node_modules','npm'),
  path.join(installation,'share','node_modules','npm'),
  path.join(installation,'share','nodejs','npm')
 ];
 const npmExecutable=path.join(path.dirname(node),'npm');
 if(fs.existsSync(npmExecutable)){
  let current;
  try{current=path.dirname(fs.realpathSync(npmExecutable));}catch{}
  while(current&&current!==path.dirname(current)){
   candidates.push(current);
   current=path.dirname(current);
  }
 }
 for(const npm of [...new Set(candidates)]){
  try{
   regularRuntimeFile(path.join(npm,'bin','npm-cli.js'),'Fixed Node npm CLI');
   regularRuntimeFile(path.join(npm,'bin','npx-cli.js'),'Fixed Node npx CLI');
   return npm;
  }catch{}
 }
 throw new Error(`Fixed Node installation must include npm beside ${nodeFilename}.`);
}

function chownTree(filename,uid,gid){
 const stat=fs.lstatSync(filename);
 if(stat.isDirectory())for(const name of fs.readdirSync(filename))chownTree(path.join(filename,name),uid,gid);
 fs.chownSync(filename,uid,gid);
}

/** Install the pinned Node plus the npm CLI needed by release verification. */
function installFixedNodeRuntime(uid,gid){
 const npmSource=fixedNpmPackage(process.execPath);
 const runtimeRoot=path.dirname(runtimeBinDir);
 ensureDirectory(runtimeRoot,uid,gid,0o755);
 for(const name of fs.readdirSync(runtimeRoot))fs.rmSync(path.join(runtimeRoot,name),{recursive:true,force:true});
 const runtimeLib=path.join(runtimeRoot,'lib','node_modules','npm');
 fs.mkdirSync(path.dirname(runtimeLib),{recursive:true,mode:0o755});
 fs.mkdirSync(runtimeBinDir,{recursive:true,mode:0o755});
 const runtimeNode=path.join(runtimeBinDir,'node');
 fs.copyFileSync(process.execPath,runtimeNode);fs.chmodSync(runtimeNode,0o755);
 fs.cpSync(npmSource,runtimeLib,{recursive:true,dereference:true});
 // Keep npm's package-relative resolution while avoiding a symlinked managed
 // executable. The wrapper always invokes the fixed runtime binary.
 for(const name of ['npm','npx']){
  const target=path.join(runtimeBinDir,name);
  fs.writeFileSync(target,`#!/bin/sh\nexec ${runtimeNode} ${path.join(runtimeLib,'bin',name==='npm'?'npm-cli.js':'npx-cli.js')} "$@"\n`,{mode:0o755});
 }
 chownTree(runtimeRoot,uid,gid);
 const updaterNode=path.join(updaterDir,'node');
 noLink(updaterNode);fs.rmSync(updaterNode,{force:true});fs.linkSync(runtimeNode,updaterNode);fs.chmodSync(updaterNode,0o755);fs.chownSync(updaterNode,uid,gid);
}

async function provisionLocked({username,uid,gid,home}){
 const existing=fs.existsSync(infrastructureFile)?readJSON(infrastructureFile):null;
 if(existing&&existing.uid!==uid)throw new Error('Changing publication user requires explicit migration.');
 installRequiredPackages();
 bootstrapTailscale();
 const directories=[
  [prefix,0o755],[releasesDir,0o755],['/var/lib/tma-deploy',0o700],[destination,0o700],
  ['/var/lib/tma-analytics',0o700],['/var/lib/tma-analytics/backups',0o700],[updaterDir,0o700],[repoDir,0o700]
 ];
 for(const [directory,mode] of directories)ensureDirectory(directory,uid,gid,mode);
 installFixedNodeRuntime(uid,gid);
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
  assertLegacyUserUnitsAbsent({home,loadState:unit=>userUnitLoadState(username,uid,unit),hasCurrentInfrastructure:()=>integratedInfrastructure(uid)});
  assertOldLayout({root:prefix,destination,currentDir:path.join(prefix,'current')});
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
