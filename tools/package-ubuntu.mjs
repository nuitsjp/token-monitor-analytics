import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const [architecture='amd64',...extra]=process.argv.slice(2);
if(!['amd64','arm64'].includes(architecture)||extra.length)throw new Error('Usage: package-ubuntu.mjs [amd64|arm64]');

// Explicit runtime allowlist: local files inside these directories must never ship.
const files=[
 'README.md','CHANGELOG.md','THIRD_PARTY_NOTICES.md','analytics/package.json',
 ...['db','estimate','platform','protocol'].map(n=>`analytics/src/${n}.ts`),
 ...['auth','backup','config','live','server','sqlite'].map(n=>`analytics/runtime/${n}.mjs`),
 ...['index.html','app.js','styles.css'].map(n=>`analytics/public/${n}`),
 ...['analytics.example.json','demo.json'].map(n=>`analytics/configs/${n}`),
 ...['analytics.ubuntu.json','collector.ubuntu.json','analytics.env.example','collector.env.example','tma-analytics.service','tma-collector.service'].map(n=>`deploy/${n}`),
 ...['UBUNTU.md','PUBLICATION.md','OPERATIONS.md','SECURITY.md','SOURCES.md','PROTOCOL.md','ESTIMATION.md','MIGRATION.md','VERIFICATION.md','architecture.md','contract.example.json'].map(n=>`docs/${n}`),
 ...fs.readdirSync(path.join(root,'analytics/migrations')).filter(n=>/^\d+_.+\.sql$/.test(n)).sort().map(n=>`analytics/migrations/${n}`)
];
// Check tools before creating any output. No shell interpolation, including on Windows.
execFileSync('tar',['--version'],{stdio:'ignore'});
const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});
const stage=fs.mkdtempSync(path.join(dist,'.tma-package-'));
try{
 const payload=path.join(stage,'payload');fs.mkdirSync(payload);
 for(const name of files){
  const source=path.join(root,name),destination=path.join(payload,name);
  if(!fs.lstatSync(source).isFile())throw new Error(`Release input must be a regular file: ${name}`);
  fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(source,destination);
 }
 execFileSync('go',['build','-trimpath','-ldflags=-s -w','-o',path.join(payload,'tma-collector'),'./cmd/collector'],{
  cwd:path.join(root,'collector'),stdio:'inherit',env:{...process.env,CGO_ENABLED:'0',GOOS:'linux',GOARCH:architecture}
 });
 fs.chmodSync(path.join(payload,'tma-collector'),0o755);
 const name=`tma-ubuntu-${architecture}.tar.gz`,archive=path.join(stage,name);
 execFileSync('tar',['-czf',archive,'-C',payload,'.'],{stdio:'inherit'});
 const checksum=createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
 fs.writeFileSync(`${archive}.sha256`,`${checksum}  ${name}\n`);
 fs.renameSync(archive,path.join(dist,name));
 fs.renameSync(`${archive}.sha256`,path.join(dist,`${name}.sha256`));
 console.log(`Created dist/${name} and dist/${name}.sha256`);
}finally{fs.rmSync(stage,{recursive:true,force:true});}
