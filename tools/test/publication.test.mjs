import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {configureApplication} from '../configure-application.mjs';
import {readEnvironment,readJSON,selectConfiguration,validateConfiguration,writeChanged,treeDigest,readPublication} from '../publish-config.mjs';
import {validateInfrastructure,unitDigest,assertInfrastructureFile} from '../ubuntu-layout.mjs';
const identity={tailnetIP:'100.69.11.74',hostname:'host.example.ts.net'};
const hubs=[{id:'hub-a',url:'https://hub.example.com',secret:'test-independent-hub-secret'}];
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tma configuration '));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('initial configuration without Hub is resumable and does not regenerate credentials',t=>{
 const dir=fixture(t);
 assert.equal(configureApplication({dir,identity}).ready,false);const before=treeDigest(dir);
 assert.deepEqual(configureApplication({dir,identity}),{ready:false,changed:false,publicOrigin:'http://host.example.ts.net:8788'});assert.equal(treeDigest(dir),before);
 const envBefore=fs.readFileSync(path.join(dir,'analytics.env'),'utf8');
 assert.equal(configureApplication({dir,identity,hubs}).ready,true);
 assert.equal(fs.readFileSync(path.join(dir,'analytics.env'),'utf8'),envBefore);
 const complete=treeDigest(dir);assert.equal(configureApplication({dir,identity,hubs}).changed,false);assert.equal(treeDigest(dir),complete);
 const plan=readJSON(path.join(dir,'connection.json'));
  const config=validateConfiguration(plan,selectConfiguration({},dir));
  assert.equal(config.analytics.tailnetViewer.host,identity.tailnetIP);
  assert.equal(config.analytics.update?.enabled,true);
  assert.equal(config.analytics.update?.branch,'main');
 });
test('invalid Hub updates leave existing configuration intact and preserve contracts',t=>{
 const dir=fixture(t);configureApplication({dir,identity,hubs});const before=treeDigest(dir);
 for(const bad of [{...hubs[0],url:'http://localhost:8765'},{...hubs[0],secret:'demo-hub-secret'}])assert.throws(()=>configureApplication({dir,identity,hubs:[bad]}));
 assert.equal(treeDigest(dir),before);
 const a=path.join(dir,'analytics.json'),raw=readJSON(a);raw.contracts=[{hubId:'hub-a'}];fs.writeFileSync(a,JSON.stringify(raw));
 assert.throws(()=>configureApplication({dir,identity,hubs:[{...hubs[0],id:'hub-b'}]}),/contract/);
 assert.deepEqual(readJSON(a).contracts,raw.contracts);
});
test('environment parser preserves literal secrets and rejects ambiguous syntax',t=>{
 const file=path.join(fixture(t),'private.env');fs.writeFileSync(file,'TOKEN="$(command); $literal value"\n',{mode:0o600});assert.equal(readEnvironment(file).TOKEN,'$(command); $literal value');
 for(const text of ['TOKEN=a\nTOKEN=b\n','export TOKEN=x\n','TOKEN=unquoted space\n']){fs.writeFileSync(file,text);assert.throws(()=>readEnvironment(file));}
 if(process.platform!=='win32'){fs.chmodSync(file,0o644);assert.throws(()=>readEnvironment(file),/0600/);}
});
test('release identity ignores timestamps and unchanged managed files retain mtime',t=>{
 const dir=fixture(t),file=path.join(dir,'unit.service');assert.equal(writeChanged(file,'first'),true);const id=treeDigest(dir);
 fs.utimesSync(file,1,1);const stamp=fs.statSync(file).mtimeMs;assert.equal(treeDigest(dir),id);
 assert.equal(writeChanged(file,'first'),false);assert.equal(fs.statSync(file).mtimeMs,stamp);
 assert.equal(writeChanged(file,'second'),true);assert.notEqual(treeDigest(dir),id);
});
test('publication requires the provisioned UID and current user service definitions',()=>{
 const record={version:2,uid:1000,unitDigest:unitDigest()};assert.doesNotThrow(()=>validateInfrastructure(record,1000));
 for(const delta of [{version:1},{uid:1001},{unitDigest:'old'}])assert.throws(()=>validateInfrastructure({...record,...delta},1000),/provision:ubuntu/);
});
test('ordinary user cannot forge a root-owned infrastructure record',t=>{
 if(process.platform==='win32'||process.getuid?.()===0){t.skip('Requires ordinary Unix user');return;}
 const file=path.join(fixture(t),'infrastructure.json');fs.writeFileSync(file,'{}',{mode:0o600});assert.throws(()=>assertInfrastructureFile(file),/root-owned/);
});
test('readPublication reads commit info or handles legacy/missing file gracefully',t=>{
  const dir=fixture(t);
  const file=path.join(dir,'publication.json');
  assert.equal(readPublication(path.join(dir,'nonexistent.json')),null);
  fs.writeFileSync(file,JSON.stringify({releaseId:'rel-legacy',configurationId:'cfg-1',publicOrigin:'http://localhost:8788'}));
  const legacy=readPublication(file);
  assert.equal(legacy.releaseId,'rel-legacy');
  assert.equal(legacy.commitSha,null);
  assert.equal(legacy.commitDate,null);
  fs.writeFileSync(file,JSON.stringify({releaseId:'rel-new',configurationId:'cfg-2',publicOrigin:'http://localhost:8788',commitSha:'abc1234567890abcdef1234567890abcdef1234',commitDate:'2026-09-06T12:00:00Z',publishedAt:'2026-09-06T12:01:00Z'}));
  const modern=readPublication(file);
  assert.equal(modern.releaseId,'rel-new');
  assert.equal(modern.commitSha,'abc1234567890abcdef1234567890abcdef1234');
  assert.equal(modern.commitDate,'2026-09-06T12:00:00Z');
  assert.equal(modern.publishedAt,'2026-09-06T12:01:00Z');
});
