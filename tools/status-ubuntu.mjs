import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {destination,infrastructureFile,appUnits,updateUnit,publicationFile,updateStateFile,validateInfrastructure,assertInfrastructureFile} from './ubuntu-layout.mjs';
import {readJSON,validateConfiguration,selectConfiguration,readPublication} from './publish-config.mjs';
import {userEnvironment,report} from './ubuntu-common.mjs';

const serviceState = (name, action) => spawnSync('/usr/bin/systemctl', ['--user', action, '--quiet', name], {stdio: 'ignore'}).status === 0;

export async function readStatus({configDir = destination, infrastructurePath = infrastructureFile, service = serviceState, fetchImpl = fetch} = {}) {
  const result = {infrastructure: false, configured: false, appUnits: {}, updateUnit: {}, health: null, publication: null, update: null};
  if (fs.existsSync(infrastructurePath)) {
    try { assertInfrastructureFile(infrastructurePath); validateInfrastructure(readJSON(infrastructurePath), process.getuid?.()); result.infrastructure = true; } catch { result.infrastructure = false; }
  }
  const selected = selectConfiguration({}, configDir);
  if (selected.analyticsConfig && fs.existsSync(selected.analyticsConfig)) {
    try {
      const config = validateConfiguration({}, selected);
      result.config = {publicOrigin: config.analytics.publicOrigin, listen: config.analytics.listen, viewerMode: config.analytics.viewerAuth.mode};
      result.configured = true;
      try {
        const response = await fetchImpl(`${config.analytics.publicOrigin}/api/health`, {signal: AbortSignal.timeout(5000)});
        result.health = response.ok;
      } catch { result.health = false; }
    } catch { result.configured = false; }
  }
  for (const unit of appUnits) result.appUnits[unit] = {active: Boolean(service(unit, 'is-active')), enabled: Boolean(service(unit, 'is-enabled'))};
  result.updateUnit = {active: Boolean(service(updateUnit, 'is-active')), enabled: Boolean(service(updateUnit, 'is-enabled'))};
  result.publication = readPublication(publicationFile);
  if (fs.existsSync(updateStateFile)) {
    try {
      const state = readJSON(updateStateFile);
      result.update = {status: state.status ?? null, stage: state.stage ?? null, errorCode: state.errorCode ?? null, targetCommitSha: state.targetCommitSha ?? null};
    } catch { result.update = null; }
  }
  result.ok = result.infrastructure && result.configured && result.health === true && appUnits.every(unit => result.appUnits[unit].active && result.appUnits[unit].enabled) && !result.updateUnit.active && !result.updateUnit.enabled;
  return result;
}

async function main() {
  userEnvironment();
  const status = await readStatus();
  console.log(JSON.stringify(status, null, 2));
  if (!status.ok) process.exitCode = 1;
}

main().catch(report);

