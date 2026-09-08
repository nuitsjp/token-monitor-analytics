import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {destination,infrastructureFile,appUnits,prefix,updateStateFile,validateInfrastructure,assertInfrastructureFile} from './ubuntu-layout.mjs';
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
   const response=await fetch(plan.publicOrigin+'/api/state',{headers:config.analytics.viewerAuth.mode==='basic'?{Authorization:'Basic '+Buffer.from(config.auth.user+':'+config.auth.password).toString('base64')}:{},signal:AbortSignal.timeout(5000)});
   check('tailnet viewer HTTP',response.status===200);
   if(response.status===200){
    const state=await response.json();console.log(`Verified viewer URL: ${plan.publicOrigin}`);
    if(config.analytics.hubsPath&&config.analytics.management.enabled){
     const r=await fetch(plan.publicOrigin+'/api/manage/hubs',{headers:config.analytics.viewerAuth.mode==='basic'?{Authorization:'Basic '+Buffer.from(config.auth.user+':'+config.auth.password).toString('base64')}:{},signal:AbortSignal.timeout(5000)});
     check('Hub management HTTP',r.ok);
     if(r.ok){
      const m=await r.json();
      if(!m.hubs.length)console.log('OK: No Hubs registered; add a Hub in the Hubs screen.');
      else if(m.hubs.every(h=>h.status==='disabled'))console.log('OK: All Hubs intentionally disabled.');
      else {
       check('Collector status known',m.collector.status!=='unknown');
       check('Hub settings applied',m.collector.appliedRevision===m.revision);
       for(const h of m.hubs){
        const report=m.collector.hubs[h.id];
        if(h.status==='disabled')console.log('OK: Hub intentionally disabled.');
        else check(report?.errorCode==='auth_failed'?'Hub authentication valid':'Hub connected',m.collector.status!=='unknown'&&report?.status==='connected');
       }
      }
     }
    }else check('Hub observations received',state.hubs?.length>0);
   }
  }catch{check('valid configuration and reachable viewer',false);}
 }
 const publicationPath=`${prefix}/publication.json`;
 if(fs.existsSync(publicationPath)){
  try{
   const pub=readJSON(publicationPath);
   console.log(`Current version: ${pub.commitSha?pub.commitSha.slice(0,12):'unknown'} (${pub.commitDate??'unknown date'}) [release: ${pub.releaseId?.slice(0,12)??'unknown'}]`);
  }catch{}
 }
 if(fs.existsSync(updateStateFile)){
  try{
   const uState=readJSON(updateStateFile);
   console.log(`Recent update: ${uState.stage} (${uState.status}) - target: ${uState.targetCommitSha?.slice(0,12)??'none'} [error: ${uState.errorCode??'none'}]`);
  }catch{}
 }
 if(incomplete)process.exitCode=1;
}
main().catch(report);
