import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {destination,infrastructureFile,appUnits,validateInfrastructure,assertInfrastructureFile} from './ubuntu-layout.mjs';
import {readJSON,validateConfiguration,selectConfiguration} from './publish-config.mjs';
import {tailnetIdentity,userEnvironment,report} from './ubuntu-common.mjs';
async function main(){
 userEnvironment();let incomplete=false;
 const check=(label,ok)=>{console.log(`${ok?'OK':'MISSING'}: ${label}`);if(!ok)incomplete=true;};
 check('environment provisioned',fs.existsSync(infrastructureFile));
 if(fs.existsSync(infrastructureFile)){try{assertInfrastructureFile();validateInfrastructure(readJSON(infrastructureFile),process.getuid());check('publication user and service definitions',true);}catch{check('publication user and service definitions',false);}}
 check('boot persistence (linger)',spawnSync('loginctl',['show-user',String(process.getuid()),'-p','Linger','--value'],{encoding:'utf8'}).stdout?.trim()==='yes');
 let identity;try{identity=tailnetIdentity();check('Tailscale connected',true);}catch{check('Tailscale connected',false);}
 const configured=['analytics.json','collector.json','analytics.env','collector.env','connection.json'].every(n=>fs.existsSync(`${destination}/${n}`));check('Hub/application configuration',configured);
 for(const unit of appUnits){check(`${unit} active`,spawnSync('systemctl',['--user','is-active','--quiet',unit]).status===0);check(`${unit} enabled`,spawnSync('systemctl',['--user','is-enabled','--quiet',unit]).status===0);}
 if(configured){
  try{
   const plan=readJSON(`${destination}/connection.json`),config=validateConfiguration(plan,selectConfiguration({}));
   check('configured address matches Tailscale',identity?.tailnetIP===plan.tailnetIP&&identity?.hostname===plan.hostname);
   const response=await fetch(plan.publicOrigin+'/api/state',{headers:{Authorization:'Basic '+Buffer.from(config.auth.user+':'+config.auth.password).toString('base64')},signal:AbortSignal.timeout(5000)});
   check('tailnet viewer HTTP',response.status===200);
   if(response.status===200){const state=await response.json();console.log(`Verified viewer URL: ${plan.publicOrigin}`);check('Hub observations received',state.hubs?.length>0);}
  }catch{check('valid configuration and reachable viewer',false);}
 }
 if(incomplete)process.exitCode=1;
}
main().catch(report);
