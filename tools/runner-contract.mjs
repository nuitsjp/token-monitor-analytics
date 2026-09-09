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

function versionNumber(value, label) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw Object.assign(new Error(`The runner contract has an invalid ${label}`), {code: 'migration_required'});
  }
  return number;
}

function versionParts(value, label) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw Object.assign(new Error(`The runner contract has an invalid ${label}`), {code: 'provision_required'});
  }
  return value.split('.').map((part, index) => versionNumber(part, `${label}.${['major', 'minor', 'patch'][index]}`));
}

function minimumParts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('The runner contract has an invalid minNode'), {code: 'migration_required'});
  }
  return [versionNumber(value.major, 'minNode.major'), versionNumber(value.minor, 'minNode.minor'), versionNumber(value.patch, 'minNode.patch')];
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
  const [major, minor, patch] = versionParts(nodeVersion, 'Node.js version');
  const [minimumMajor, minimumMinor, minimumPatch] = minimumParts(minimum);
  if (major < minimumMajor || (major === minimumMajor && (minor < minimumMinor || (minor === minimumMinor && patch < minimumPatch)))) {
    throw Object.assign(new Error(`Node.js ${minimumMajor}.${minimumMinor}.${minimumPatch} or newer is required`), {code: 'provision_required'});
  }
  return true;
}
