// Keep this object small and stable. update-runner.mjs copies this module to
// /var/lib/tma-deploy/updater and uses it before it touches the live service.
export const MIN_NODE_VERSION = Object.freeze({major: 22, minor: 16, patch: 0});
export const RUNTIME_CONTRACT_VERSION = 2;
export const RUNNER_CONTRACT = Object.freeze({
  configVersion: 2,
  serviceContractVersion: RUNTIME_CONTRACT_VERSION,
  runnerVersion: 1,
  minNode: MIN_NODE_VERSION,
  appUnits: Object.freeze(['tma-analytics.service']),
  managedUnits: Object.freeze(['tma-analytics.service', 'tma-update.service'])
});

function versionNumber(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * Validate only the machine contract needed to run a release.  This function
 * deliberately accepts a manifest/infrastructure record rather than a full
 * Analytics config, so the isolated runner cannot accidentally import Hub rows
 * or secrets.
 */
export function validateRunnerContract(record = {}, {nodeVersion = process.versions.node} = {}) {
  const contract = record.runtimeContract ?? record;
  if (contract.configVersion !== RUNNER_CONTRACT.configVersion ||
      contract.serviceContractVersion !== RUNNER_CONTRACT.serviceContractVersion ||
      contract.runnerVersion !== RUNNER_CONTRACT.runnerVersion ||
      JSON.stringify(contract.appUnits) !== JSON.stringify(RUNNER_CONTRACT.appUnits) ||
      JSON.stringify(contract.managedUnits) !== JSON.stringify(RUNNER_CONTRACT.managedUnits)) {
    throw Object.assign(new Error('The release requires an incompatible Analytics/update service contract'), {code: 'migration_required'});
  }
  const minimum = contract.minNode ?? RUNNER_CONTRACT.minNode;
  const [major, minor, patch] = String(nodeVersion).split('.').map(value => Number(value));
  if (![major, minor, patch].every(Number.isInteger) || major < minimum.major || (major === minimum.major && minor < minimum.minor)) {
    throw Object.assign(new Error(`Node.js ${minimum.major}.${minimum.minor} or newer is required`), {code: 'provision_required'});
  }
  return true;
}
