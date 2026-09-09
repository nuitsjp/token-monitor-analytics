import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {destination,infrastructureFile,deploymentLock,validateInfrastructure,assertInfrastructureFile} from './ubuntu-layout.mjs';
import {readJSON} from './publish-config.mjs';
import {configureApplication} from './configure-application.mjs';
import {userEnvironment,tailnetIdentity,report} from './ubuntu-common.mjs';
import {withPublicationLock} from './release.mjs';

async function main() {
  userEnvironment();
  let values;
  try {
    ({values} = parseArgs({options: {port: {type: 'string'}, 'listen-host': {type: 'string'}, 'viewer-mode': {type: 'string'}, 'public-origin': {type: 'string'}}, strict: true}));
  } catch { throw new Error('Invalid configuration arguments; configure accepts only --port, --listen-host, --viewer-mode and --public-origin.'); }
  if (!fs.existsSync(infrastructureFile)) throw new Error('Run provision:ubuntu first; it does not require Hub configuration.');
  assertInfrastructureFile();
  validateInfrastructure(readJSON(infrastructureFile), process.getuid());
  const previous = fs.existsSync(`${destination}/connection.json`) ? readJSON(`${destination}/connection.json`) : {};
  let identity = {};
  if (!values['listen-host'] && !values['viewer-mode'] && !values['public-origin'] && !values.port) {
    try { identity = tailnetIdentity(); } catch { identity = {}; }
  }
  const port = values.port === undefined ? previous.listen?.port ?? previous.port ?? identity.port ?? 8788 : Number(values.port);
  await withPublicationLock(deploymentLock, async () => {
    const result = configureApplication({
      dir: destination,
      identity,
      port,
      listenHost: values['listen-host'] ?? previous.listen?.host,
      viewerMode: values['viewer-mode'] ?? previous.viewerMode,
      publicOrigin: values['public-origin'] ?? previous.publicOrigin
    });
    console.log(result.changed ? 'Private startup configuration saved.' : 'SKIP: startup configuration already matches.');
    console.log(`Configuration ready for ${result.publicOrigin}; run publish:ubuntu to verify and publish the application.`);
  });
}

main().catch(report);
