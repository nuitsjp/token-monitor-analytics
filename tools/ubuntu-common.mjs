import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {isIP} from 'node:net';

export function run(command, args, options = {}) {
  try { return execFileSync(command, args, {encoding: 'utf8', stdio: 'pipe', ...options}); }
  catch { throw new Error(`${path.basename(command)} failed; inspect host configuration locally (sensitive output suppressed).`); }
}

export function inherit(command, args, {lock = false} = {}) {
  const result = spawnSync(command, args, {stdio: 'inherit'});
  if (result.error) throw new Error(`Cannot start ${path.basename(command)}.`);
  if (result.status !== 0) {
    if (lock && result.status === 75) throw new Error('Another environment/configuration/publication task holds the deployment lock.');
    throw Object.assign(new Error(), {reported: true, exitCode: result.status ?? 1});
  }
}

export function report(error) {
  if (!error?.reported) console.error(error?.code === 'ENOENT' || error instanceof SyntaxError ? 'Required host file or permission is missing; run status:ubuntu for prerequisites.' : (error?.message ?? 'Task failed.'));
  process.exitCode = error?.exitCode ?? 1;
}

export function userEnvironment() {
  if (process.platform !== 'linux' || process.getuid?.() === 0) throw new Error('Run this task as the configured ordinary Ubuntu user, without sudo.');
  process.env.XDG_RUNTIME_DIR ??= `/run/user/${process.getuid()}`;
  process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;
}

/** Migration-only helper; normal configure/publish has no Tailscale subprocess dependency. */
export function tailnetIdentity() {
  let state;
  try { state = JSON.parse(run('/usr/bin/tailscale', ['status', '--json'])); }
  catch { throw new Error('Tailscale is unavailable; run provision:ubuntu or choose loopback configuration.'); }
  const ip = state.Self?.TailscaleIPs?.find(value => isIP(value) === 4 && value.split('.').map(Number)[0] === 100);
  const hostname = state.Self?.DNSName?.replace(/\.$/, '');
  if (state.BackendState !== 'Running' || !ip || !hostname || !hostname.endsWith('.ts.net')) throw new Error('Tailscale is not connected. Complete tailscale up, then retry.');
  return {tailnetIP: ip, hostname, viewerMode: 'tailscale'};
}

export function privateText(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Private input must be a regular file with mode 0600.');
  return fs.readFileSync(file, 'utf8');
}

