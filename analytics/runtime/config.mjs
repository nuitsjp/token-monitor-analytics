import fs from 'node:fs';
import path from 'node:path';
import {isIP} from 'node:net';
import {validateContracts} from '../src/estimate.ts';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const safeId = x => typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(x);
const envName = x => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(x);
export const isLoopback = ip => ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';
const keys = (x, allowed, label) => {
 if (!object(x) || Object.keys(x).some(k => !allowed.includes(k))) throw new Error(`Invalid or unknown ${label} field`);
};
export function loadConfig(filename) {
 const absolute = path.resolve(filename);
 if (fs.statSync(absolute).size > 262144) throw new Error('Config too large');
 const raw = JSON.parse(fs.readFileSync(absolute,'utf8').replace(/^\uFEFF/,''));
 keys(raw,['version','listen','publicOrigin','databasePath','timeZone','detailRetentionDays','ingestTokenEnv','viewerAuth','hubs','contracts','demo'],'configuration');
 if (raw.version !== 1 || typeof raw.demo !== 'boolean') throw new Error('version=1 and explicit demo boolean are required');
 keys(raw.listen,['host','port'],'listen');
 const {host,port} = raw.listen;
 if (!isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('listen requires an IP literal and port 1..65535');
 if (typeof raw.publicOrigin !== 'string') throw new Error('publicOrigin is required');
 const origin = new URL(raw.publicOrigin);
 if (!['http:','https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('publicOrigin must be an HTTP(S) origin without credentials or path');
 if (typeof raw.databasePath !== 'string' || !raw.databasePath.trim() || raw.databasePath === ':memory:') throw new Error('databasePath must be a file');
 if (!Number.isInteger(raw.detailRetentionDays) || raw.detailRetentionDays < 1 || raw.detailRetentionDays > 3650) throw new Error('detailRetentionDays must be 1..3650');
 if (typeof raw.timeZone !== 'string') throw new Error('timeZone required');
 new Intl.DateTimeFormat('en',{timeZone:raw.timeZone});
 if (!envName(raw.ingestTokenEnv)) throw new Error('Invalid ingestTokenEnv');
 keys(raw.viewerAuth,['mode','userEnv','passwordEnv'],'viewerAuth');
 if (!['loopback','basic'].includes(raw.viewerAuth.mode)) throw new Error('viewerAuth mode must be loopback or basic');
 if (raw.viewerAuth.mode === 'basic' && (!envName(raw.viewerAuth.userEnv) || !envName(raw.viewerAuth.passwordEnv))) throw new Error('Basic auth environment names required');
 // No plaintext non-loopback listener. Remote publication requires an explicit HTTPS reverse proxy origin.
 if (!isLoopback(host) && (raw.viewerAuth.mode !== 'basic' || origin.protocol !== 'https:')) throw new Error('Non-loopback listener requires basic auth and an HTTPS reverse proxy origin');
 if (raw.viewerAuth.mode === 'loopback' && (!isLoopback(host) || !['localhost','127.0.0.1','[::1]'].includes(origin.hostname))) throw new Error('Loopback viewer mode is local-only');
 if (raw.demo && (!isLoopback(host) || raw.viewerAuth.mode !== 'loopback' || origin.protocol !== 'http:')) throw new Error('Demo must remain loopback-only');
 if (!Array.isArray(raw.hubs) || raw.hubs.length < 1 || raw.hubs.length > 16) throw new Error('Configure 1..16 hubs');
 const ids = new Set();
 for (const hub of raw.hubs) {
  keys(hub,['id','label'],'hub');
  if (!safeId(hub.id) || ids.has(hub.id) || typeof hub.label !== 'string' || !hub.label || hub.label.length > 128) throw new Error('Invalid/duplicate hub');
  ids.add(hub.id);
 }
 if (!Array.isArray(raw.contracts)) throw new Error('contracts must be an array');
 const contractFields=['id','label','hubId','provider','accountKey','clientIds','deviceIds','windowKind','windowHours','monthlyFeeUsd','attributionConfirmed','minDeltaPercent','maxSourceSkewSeconds','maxGapSeconds'];
 for (const c of raw.contracts) {
  keys(c,contractFields,'contract');
  if (!safeId(c.id) || typeof c.attributionConfirmed !== 'boolean' || !Array.isArray(c.clientIds) || !Array.isArray(c.deviceIds) || ![...c.clientIds,...c.deviceIds].every(x=>typeof x==='string'&&x.length>0&&x.length<=256) || ![c.label,c.hubId,c.provider,c.accountKey,c.windowKind].every(x=>typeof x==='string'&&x.length>0&&x.length<=256)) throw new Error('Invalid contract identity');
 }
 validateContracts(raw.contracts,[...ids]);
 return {...raw,publicOrigin:origin.origin,databasePath:path.resolve(path.dirname(absolute),raw.databasePath),configFile:absolute};
}
export function credentials(config, env=process.env) {
 const secret = (name,min) => {
  const value=env[name];
  if (typeof value !== 'string' || value.length < min || value.startsWith('REPLACE_') || /[\r\n\0]/.test(value)) throw new Error(`Missing/short/invalid environment variable: ${name}`);
  return value;
 };
 const ingest = secret(config.ingestTokenEnv,32);
 if (!config.demo && ingest === 'demo-ingest-token-not-for-production') throw new Error('Demo token is prohibited outside demo');
 if (config.viewerAuth.mode === 'basic') {
  const user=secret(config.viewerAuth.userEnv,1),password=secret(config.viewerAuth.passwordEnv,16);
  if (user.includes(':') || password === ingest) throw new Error('Viewer credentials must be independent of ingest token');
  return {ingest,user,password};
 }
 return {ingest};
}
