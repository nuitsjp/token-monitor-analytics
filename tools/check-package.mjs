import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const [architecture='amd64',...extra]=process.argv.slice(2);
assert.ok(['amd64','arm64'].includes(architecture)&&extra.length===0,'Expected amd64 or arm64');
const name=`tma-ubuntu-${architecture}.tar.gz`,archive=path.join(root,'dist',name);
const hash=createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
assert.equal(fs.readFileSync(`${archive}.sha256`,'utf8'),`${hash}  ${name}\n`);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tma package check '));
let app;
try{
 execFileSync('tar',['-xzf',archive,'-C',temp],{stdio:'inherit'});
 const entries=fs.readdirSync(temp,{recursive:true}).map(String);
 assert.ok(!entries.some(n=>/(^|[/\\])(node_modules|data|outbox|\.git|\.wrangler)([/\\]|$)|config\.local\.json$|\.env$|\.(db|sqlite)(-|$)/.test(n)),'Private files in package');
 for(const n of ['analytics/src/index.ts','analytics/src/auth.ts','analytics/wrangler.jsonc'])assert.equal(fs.existsSync(path.join(temp,n)),false,'Legacy Cloudflare file in native package');
 const binary=fs.readFileSync(path.join(temp,'tma-collector'));
 assert.equal(binary.subarray(0,4).toString('hex'),'7f454c46','Collector must be Linux ELF');
 assert.equal(binary.readUInt16LE(18),architecture==='amd64'?62:183,'Wrong Collector architecture');
 const {loadConfig}=await import(pathToFileURL(path.join(temp,'analytics/runtime/config.mjs')).href);
 const {startServer}=await import(pathToFileURL(path.join(temp,'analytics/runtime/server.mjs')).href);
 const config=loadConfig(path.join(temp,'analytics/configs/demo.json'));
 config.databasePath=path.join(temp,'test.db');config.listen.port=0;
 app=await startServer(config,{env:{[config.ingestTokenEnv]:'demo-ingest-token-not-for-production'},logger:{info(){},error:console.error}});
 config.publicOrigin=`http://127.0.0.1:${app.server.address().port}`;
 for(const route of ['/','/app.js','/styles.css','/api/state']){
  const response=await fetch(config.publicOrigin+route);assert.equal(response.status,200,route);await response.arrayBuffer();
 }
 console.log(`PASS: ${architecture} checksum, package contents, ELF target, extracted Analytics HTTP/SQLite`);
}finally{
 if(app)await app.close();
 fs.rmSync(temp,{recursive:true,force:true});
}
