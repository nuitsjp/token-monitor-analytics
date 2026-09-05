import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const result=spawnSync('gofmt',['-l','.'],{
 cwd:fileURLToPath(new URL('../collector/',import.meta.url)),encoding:'utf8'
});
if(result.error)throw result.error;
if(result.stderr)process.stderr.write(result.stderr);
if(result.status!==0)process.exit(result.status??1);
if(result.stdout.trim()){
 console.error(`Run gofmt on these files:\n${result.stdout.trim()}`);
 process.exitCode=1;
}
