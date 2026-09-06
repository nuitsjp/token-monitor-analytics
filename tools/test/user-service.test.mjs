import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {userUnit,prefix,destination} from '../ubuntu-layout.mjs';
import {fileURLToPath} from 'node:url';
const supported=process.platform==='linux'&&process.getuid?.()!==0&&spawnSync('systemctl',['--user','show-environment'],{stdio:'ignore'}).status===0;
test('ordinary user starts and restarts a native Analytics service without privilege escalation', {skip:supported?false:'Requires a running user systemd manager',timeout:20000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tma-user-service-'));
 const name=`tma-test-${process.pid}.service`;
 const ctl=(...args)=>execFileSync('systemctl',['--user',...args],{encoding:'utf8',stdio:'pipe'});
 let linked=false;
 try{
  const current=path.join(dir,'current');fs.mkdirSync(current);
  fs.symlinkSync(process.execPath,path.join(current,'node'));
  fs.symlinkSync(fileURLToPath(new URL('../../analytics/',import.meta.url)),path.join(current,'analytics'));
  const configDir=path.join(dir,'config');fs.mkdirSync(configDir);
  const net=await import('node:net');const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const config=JSON.parse(fs.readFileSync(new URL('../../analytics/configs/demo.json',import.meta.url),'utf8'));
  config.listen.port=port;config.publicOrigin=`http://127.0.0.1:${port}`;config.databasePath=path.join(dir,'demo.db');
  fs.writeFileSync(path.join(configDir,'analytics.json'),JSON.stringify(config),{mode:0o600});
  fs.writeFileSync(path.join(configDir,'analytics.env'),'TMA_INGEST_TOKEN=demo-ingest-token-not-for-production\n',{mode:0o600});
  const unit=userUnit('tma-analytics.service').replaceAll(prefix,dir).replaceAll(destination,configDir);
  const unitPath=path.join(dir,name);fs.writeFileSync(unitPath,unit);
  ctl('link',unitPath);linked=true;ctl('daemon-reload');ctl('start',name);
  async function healthy(){
   for(let i=0;i<50;i++){try{const r=await fetch(config.publicOrigin+'/api/health');if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}
   throw new Error('User service did not become healthy');
  }
  await healthy();const firstPid=ctl('show','-p','MainPID','--value',name).trim();assert.notEqual(firstPid,'0');
  ctl('start',name);assert.equal(ctl('show','-p','MainPID','--value',name).trim(),firstPid,'Starting an already active service must not restart it');
  assert.ok(fs.existsSync(config.databasePath));
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(config.databasePath);
  db.exec('CREATE TABLE publication_test (value TEXT); INSERT INTO publication_test VALUES (\'retained\')');db.close();
  execFileSync(process.execPath,['--experimental-strip-types',path.join(current,'analytics/runtime/backup.mjs'),'--config',path.join(configDir,'analytics.json'),'--output',path.join(dir,'backup.db')],{stdio:'pipe'});
  assert.ok(fs.existsSync(path.join(dir,'backup.db')),'Backup CLI must work through the current symlink');
  ctl('restart',name);await healthy();assert.notEqual(ctl('show','-p','MainPID','--value',name).trim(),firstPid);
  const reopened=new DatabaseSync(config.databasePath,{readOnly:true});assert.equal(reopened.prepare('SELECT value FROM publication_test').get().value,'retained');reopened.close();
 }finally{
  if(linked){try{ctl('stop',name);}finally{ctl('disable',name);ctl('daemon-reload');}}
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
