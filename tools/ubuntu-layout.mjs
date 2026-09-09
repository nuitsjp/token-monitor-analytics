import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {RUNNER_CONTRACT} from './runner-contract.mjs';

export const prefix = '/opt/token-monitor-analytics';
export const currentDir = `${prefix}/current`;
export const releasesDir = `${prefix}/releases`;
export const destination = '/var/lib/tma-deploy/config';
export const appUnits = Object.freeze(['tma-analytics.service']);
export const updateUnit = 'tma-update.service';
export const managedUnits = Object.freeze([...appUnits, updateUnit]);
// These names are checked in the system manager before provisioning creates
// or changes any managed path. The new installation owns user units with the
// same application name; a loaded system unit is an old installation and must
// go through the explicit migration procedure.
export const legacySystemUnits = Object.freeze([
  'tma-analytics.service',
  'tma-collector.service',
  'tma-update.service'
]);
export const updaterDir = '/var/lib/tma-deploy/updater';
export const repoDir = '/var/lib/tma-deploy/repo';
export const updateStateFile = '/var/lib/tma-deploy/update-state.json';
export const publicationFile = `${prefix}/publication.json`;
export const infrastructureFile = '/etc/token-monitor-analytics/infrastructure.json';
export const deploymentLock = '/var/lib/tma-lock/deploy.lock';
export const infrastructureVersion = 3;
export const configVersion = RUNNER_CONTRACT.configVersion;
export const serviceContractVersion = RUNNER_CONTRACT.serviceContractVersion;
export const runnerVersion = RUNNER_CONTRACT.runnerVersion;

// This is the complete dependency closure of the independent update launcher.
// It must remain usable after the development checkout and Analytics source
// tree have been removed.
export const updaterRunnerFiles = Object.freeze([
  'tools/update-runner.mjs',
  'tools/update-runner-state.mjs',
  'tools/runner-contract.mjs'
]);

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function userUnit(name) {
  if (name === updateUnit) {
    return `[Unit]
Description=Token Monitor Analytics update runner (oneshot)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${updaterDir}
ExecStart=${updaterDir}/node --experimental-strip-types ${updaterDir}/tools/update-runner.mjs
UMask=0077
NoNewPrivileges=true
`;
  }
  if (!appUnits.includes(name)) throw new Error('Unknown application unit.');
  return `[Unit]
StartLimitIntervalSec=120
StartLimitBurst=6
Description=Token Monitor Analytics (native Node.js + SQLite)
After=network-online.target
Wants=network-online.target
ConditionPathExists=${currentDir}/node

[Service]
Type=simple
WorkingDirectory=${currentDir}
Environment=NODE_ENV=production
EnvironmentFile=${destination}/analytics.env
ExecStart=${currentDir}/node --experimental-strip-types ${currentDir}/analytics/runtime/server.mjs --config ${destination}/analytics.json
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/tma-analytics /var/lib/tma-deploy
RestrictSUIDSGID=true

[Install]
WantedBy=default.target
`;
}

export function unitDigest() {
  return digest(Buffer.from(managedUnits.map(userUnit).join('\n')));
}

export function runtimeContract() {
  return {
    configVersion,
    serviceContractVersion,
    runnerVersion,
    minNode: RUNNER_CONTRACT.minNode,
    appUnits: [...appUnits],
    managedUnits: [...managedUnits]
  };
}

export function validateInfrastructure(record, uid) {
  const valid = record && record.version === infrastructureVersion && record.uid === uid && record.configVersion === configVersion && record.serviceContractVersion === serviceContractVersion && record.runnerVersion === runnerVersion && JSON.stringify(record.appUnits) === JSON.stringify(appUnits) && JSON.stringify(record.managedUnits) === JSON.stringify(managedUnits) && record.unitDigest === unitDigest();
  if (!valid) throw new Error('Infrastructure is missing, changed or belongs to another user. Ask an administrator to run mise run provision:ubuntu.');
  return true;
}

export function assertInfrastructureFile(filename = infrastructureFile) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('Infrastructure record must be a root-owned file, not writable by group/others.');
  return true;
}
