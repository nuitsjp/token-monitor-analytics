import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readJSON} from '../publish-config.mjs';
const cli=fileURLToPath(new URL('../provision-ubuntu.mjs',import.meta.url));
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tma provision cli '));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('privileged phase refuses an ordinary user without requiring a deployment manifest',{skip:process.platform!=='linux'||process.getuid?.()===0},()=>{
 const result=spawnSync(process.execPath,['--experimental-strip-types',cli,'--apply','--user','ubuntu'],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,1);assert.match(result.stderr,/Only provisioning requires root/);assert.doesNotMatch(result.stderr,/deployment JSON|sudo failed|flock failed/);
});
test('JSON reader distinguishes missing, malformed and unreadable files',t=>{
 const dir=fixture(t),file=path.join(dir,'settings.json');
 assert.throws(()=>readJSON(file),e=>e.missingFile===true);
 fs.writeFileSync(file,'{');assert.throws(()=>readJSON(file),/Invalid JSON syntax/);
 if(process.platform!=='win32'&&process.getuid?.()!==0){
  fs.chmodSync(file,0);try{assert.throws(()=>readJSON(file),e=>e.needsRootRead===true);}finally{fs.chmodSync(file,0o600);}
 }
 fs.writeFileSync(file,'\ufeff{"version":1}');assert.equal(readJSON(file).version,1);
});

test('secret argument conflicts and parse failures never echo the supplied secret',{skip:process.platform!=='linux'||process.getuid?.()===0},()=>{
 const configure=fileURLToPath(new URL('../configure-ubuntu.mjs',import.meta.url));
 const secret='test-sensitive-argument-do-not-log';
 for(const args of [
  ['--hub-secret',secret,'--hub-secret-file','/unused'],
  ['--hub-secret',secret,'--hubs-file','/unused'],
  ['--hub-secret',secret,'--unknown='+secret],
 ]){
  const result=spawnSync(process.execPath,['--experimental-strip-types',configure,...args],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.ok(!(result.stdout+result.stderr).includes(secret));
  assert.match(result.stderr,/Choose either|Invalid configuration arguments/);
 }
});
