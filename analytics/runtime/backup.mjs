import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {loadConfig} from './config.mjs';
import {backupDatabase} from './sqlite.mjs';
async function main(){
 const {values}=parseArgs({options:{config:{type:'string',default:'config.local.json'},output:{type:'string'}},strict:true});
 if(!values.output)throw new Error('Specify --output PATH (existing file will not be overwritten)');
 const config=loadConfig(values.config);
 await backupDatabase(config.databasePath,values.output);
 console.log('SQLite backup completed. Protect this file as private usage data.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
