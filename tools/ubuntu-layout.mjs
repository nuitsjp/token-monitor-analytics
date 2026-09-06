import fs from 'node:fs';
import {createHash} from 'node:crypto';

export const prefix='/opt/token-monitor-analytics';
export const destination='/var/lib/tma-deploy/config';
export const appUnits=['tma-analytics.service','tma-collector.service'];
export const updateUnit='tma-update.service';
export const managedUnits=[...appUnits,updateUnit];
export const updaterDir='/var/lib/tma-deploy/updater';
export const repoDir='/var/lib/tma-deploy/repo';
export const updateStateFile='/var/lib/tma-deploy/update-state.json';
export const infrastructureFile='/etc/token-monitor-analytics/infrastructure.json';
export const updaterRunnerFiles=[
 'analytics/package.json',
 'tools/update-runner.mjs',
 'tools/ubuntu-layout.mjs',
 'tools/publish-config.mjs',
 'tools/ubuntu-common.mjs',
 'analytics/runtime/update-state.mjs',
 'analytics/runtime/config.mjs',
 'analytics/runtime/hubs.mjs',
 'analytics/src/estimate.ts',
 'analytics/src/hubs.ts'
];
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function userUnit(name){
 if(name===updateUnit){
  return `[Unit]
Description=Token Monitor Analytics Update Runner (publication user)
After=network.target

[Service]
Type=oneshot
WorkingDirectory=/var/lib/tma-deploy
EnvironmentFile=${destination}/analytics.env
ExecStart=${updaterDir}/node --experimental-strip-types ${updaterDir}/tools/update-runner.mjs
UMask=0077
NoNewPrivileges=true
`;
 }
 const analytics=name===appUnits[0];
 if(!appUnits.includes(name))throw new Error('Unknown application unit.');
 return `[Unit]
StartLimitIntervalSec=0
Description=Token Monitor ${analytics?'Analytics':'Collector'} (publication user)
${analytics?'':'After=tma-analytics.service\n'}ConditionPathExists=${prefix}/current/${analytics?'node':'tma-collector'}

[Service]
Type=simple
WorkingDirectory=${prefix}/current
EnvironmentFile=${destination}/${analytics?'analytics':'collector'}.env
ExecStart=${analytics?`${prefix}/current/node --experimental-strip-types ${prefix}/current/analytics/runtime/server.mjs --config ${destination}/analytics.json`:`${prefix}/current/tma-collector -config ${destination}/collector.json`}
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}
export function unitDigest(){return digest(managedUnits.map(userUnit).join('\n'));}
export function validateInfrastructure(record,uid){
 if(record.version!==2||record.uid!==uid||record.unitDigest!==unitDigest())throw new Error('Infrastructure is missing, changed or belongs to another user. Ask an administrator to run mise run provision:ubuntu.');
}
export function assertInfrastructureFile(filename=infrastructureFile){
 const stat=fs.lstatSync(filename);
 if(!stat.isFile()||stat.uid!==0||(stat.mode&0o022))throw new Error('Infrastructure record must be a root-owned file, not writable by group/others.');
}
