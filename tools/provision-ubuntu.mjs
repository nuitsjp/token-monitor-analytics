import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {readJSON,writeChanged} from './publish-config.mjs';
import {prefix,currentDir,releasesDir,destination,appUnits,managedUnits,updaterDir,repoDir,infrastructureFile,deploymentLock,userUnit,unitDigest,updaterRunnerFiles,infrastructureVersion,configVersion,serviceContractVersion,runnerVersion,runtimeContract} from './ubuntu-layout.mjs';
import {run,inherit,report} from './ubuntu-common.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const systemctl = (...args) => run('/usr/bin/systemctl', args);

function noLink(filename) {
  try { if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('Managed paths must not be symlinks.'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

function ensureDirectory(filename, uid, gid, mode) {
  noLink(filename);
  fs.mkdirSync(filename, {recursive: true, mode});
  const stat = fs.statSync(filename);
  if (stat.uid !== uid || stat.gid !== gid) fs.chownSync(filename, uid, gid);
  if ((stat.mode & 0o777) !== mode) fs.chmodSync(filename, mode);
}

function userController(username, uid) {
  return (...args) => run('/usr/sbin/runuser', ['-u', username, '--', '/usr/bin/env', `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, '/usr/bin/systemctl', '--user', ...args]);
}

async function main() {
  const {values} = parseArgs({options: {user: {type: 'string'}, apply: {type: 'boolean'}, locked: {type: 'boolean'}}, strict: true});
  if (process.platform !== 'linux') throw new Error('Provisioning requires Ubuntu/systemd.');
  const username = values.user ?? process.env.TMA_DEPLOY_USER ?? process.env.SUDO_USER ?? process.env.USER;
  if (!/^[a-z_][a-z0-9_-]*$/.test(username ?? '') || username === 'root') throw new Error('Set TMA_DEPLOY_USER to an existing ordinary publication user.');
  if (!values.apply) {
    const args = [process.execPath, '--experimental-strip-types', fileURLToPath(import.meta.url), '--apply', '--user', username];
    if (process.getuid?.() === 0) inherit(args[0], args.slice(1));
    else inherit('/usr/bin/sudo', args);
    return;
  }
  if (process.getuid?.() !== 0) throw new Error('Only provisioning requires root.');
  const passwd = run('/usr/bin/getent', ['passwd', username]).trim().split(':');
  const uid = Number(passwd[2]), gid = Number(passwd[3]), home = passwd[5];
  if (!Number.isInteger(uid) || uid < 1000 || !home?.startsWith('/')) throw new Error('An existing ordinary user is required.');
  if (!values.locked) {
    noLink('/var/lib/tma-lock');
    fs.mkdirSync('/var/lib/tma-lock', {recursive: true, mode: 0o755});
    noLink(deploymentLock);
    if (!fs.existsSync(deploymentLock)) fs.closeSync(fs.openSync(deploymentLock, 'a+', 0o600));
    fs.chownSync(deploymentLock, uid, gid);
    inherit('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '75', deploymentLock, process.execPath, '--experimental-strip-types', fileURLToPath(import.meta.url), '--apply', '--locked', '--user', username], {lock: true});
    return;
  }
  const existing = fs.existsSync(infrastructureFile) ? readJSON(infrastructureFile) : null;
  if (existing && existing.uid !== uid) throw new Error('Changing publication user requires explicit migration.');
  const directories = [
    [prefix, 0o755], [releasesDir, 0o755], ['/var/lib/tma-deploy', 0o700], [destination, 0o700],
    ['/var/lib/tma-analytics', 0o700], ['/var/lib/tma-analytics/backups', 0o700], [updaterDir, 0o700], [repoDir, 0o700]
  ];
  for (const [directory, mode] of directories) ensureDirectory(directory, uid, gid, mode);
  const updaterNode = path.join(updaterDir, 'node');
  fs.copyFileSync(process.execPath, updaterNode); fs.chmodSync(updaterNode, 0o755); fs.chownSync(updaterNode, uid, gid);
  for (const relative of updaterRunnerFiles) {
    const source = path.join(sourceRoot, relative), target = path.join(updaterDir, relative);
    if (!fs.lstatSync(source).isFile()) throw new Error(`Updater dependency is missing: ${relative}`);
    fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o755});
    fs.copyFileSync(source, target); fs.chmodSync(target, 0o755); fs.chownSync(target, uid, gid);
  }
  const userUnits = path.join(home, '.config/systemd/user');
  ensureDirectory(path.join(home, '.config'), uid, gid, 0o700);
  ensureDirectory(path.join(home, '.config/systemd'), uid, gid, 0o700);
  ensureDirectory(userUnits, uid, gid, 0o700);
  let changed = false;
  for (const unit of managedUnits) {
    const filename = path.join(userUnits, unit);
    noLink(filename);
    changed = writeChanged(filename, userUnit(unit), 0o644) || changed;
    fs.chownSync(filename, uid, gid);
  }
  if (spawnSync('/usr/bin/loginctl', ['show-user', username, '-p', 'Linger', '--value'], {encoding: 'utf8'}).stdout?.trim() !== 'yes') run('/usr/bin/loginctl', ['enable-linger', username]);
  systemctl('start', `user@${uid}.service`);
  const userctl = userController(username, uid);
  if (changed) userctl('daemon-reload');
  // Update is a oneshot and must not be enabled as an application service.
  for (const unit of appUnits) userctl('enable', unit);
  noLink(path.dirname(infrastructureFile));
  fs.mkdirSync(path.dirname(infrastructureFile), {recursive: true, mode: 0o755});
  noLink(infrastructureFile);
  const record = {
    version: infrastructureVersion,
    uid,
    username,
    configVersion,
    serviceContractVersion,
    runnerVersion,
    appUnits: [...appUnits],
    managedUnits: [...managedUnits],
    unitDigest: unitDigest(),
    runtimeContract: runtimeContract()
  };
  writeChanged(infrastructureFile, `${JSON.stringify(record, null, 2)}\n`, 0o644);
  console.log('Environment provisioned. Run configure:ubuntu and publish:ubuntu as the publication user.');
}

main().catch(report);

