import fs from 'node:fs';
import path from 'node:path';
import {isIP} from 'node:net';
import {networkInterfaces} from 'node:os';
import {validateContracts} from '../src/estimate.ts';
import {readHubsConfig} from './hubs.mjs';

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
 keys(raw,['version','listen','publicOrigin','databasePath','timeZone','detailRetentionDays','ingestTokenEnv','viewerAuth','hubs','hubsPath','contracts','demo','tailnetViewer','management','update'],'configuration');
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
 if (!['loopback','basic','tailscale'].includes(raw.viewerAuth.mode)) throw new Error('viewerAuth mode must be loopback, basic or tailscale');
 if (raw.viewerAuth.mode === 'basic' && (!envName(raw.viewerAuth.userEnv) || !envName(raw.viewerAuth.passwordEnv))) throw new Error('Basic auth environment names required');
 // No plaintext non-loopback listener. Remote publication requires an explicit HTTPS reverse proxy origin.
 if (!isLoopback(host) && (raw.viewerAuth.mode !== 'basic' || origin.protocol !== 'https:')) throw new Error('Non-loopback listener requires basic auth and an HTTPS reverse proxy origin');
 if (raw.viewerAuth.mode === 'loopback' && (!isLoopback(host) || !['localhost','127.0.0.1','[::1]'].includes(origin.hostname))) throw new Error('Loopback viewer mode is local-only');
 if (raw.demo && (!isLoopback(host) || raw.viewerAuth.mode !== 'loopback' || origin.protocol !== 'http:')) throw new Error('Demo must remain loopback-only');
 if(raw.tailnetViewer!==undefined){
  keys(raw.tailnetViewer,['host','port'],'tailnetViewer');
  if(!isTailnetIPv4(raw.tailnetViewer.host)||!Number.isInteger(raw.tailnetViewer.port)||raw.tailnetViewer.port<1024||raw.tailnetViewer.port>65535||host!=='127.0.0.1'||raw.demo||!['basic','tailscale'].includes(raw.viewerAuth.mode)||origin.protocol!=='http:'||!origin.hostname.endsWith('.ts.net')||Number(origin.port||80)!==raw.tailnetViewer.port)throw new Error('Tailnet viewer requires an explicit Tailscale IPv4, HTTP ts.net origin, basic/tailscale mode, REAL data and loopback ingest.');
 }
 if(raw.viewerAuth.mode==='tailscale'&&!raw.tailnetViewer)throw new Error('Tailscale viewer mode requires a dedicated tailnet listener.');
 if (raw.management !== undefined) {
  keys(raw.management, ['enabled'], 'management');
  if (typeof raw.management.enabled !== 'boolean') throw new Error('management.enabled must be a boolean');
 }
 const managementEnabled = Boolean(raw.management?.enabled);
 if (raw.update !== undefined) {
  keys(raw.update, ['enabled', 'repositoryUrl', 'branch', 'checkIntervalSeconds', 'statePath', 'repoPath', 'publicationPath'], 'update');
  if (typeof raw.update.enabled !== 'boolean') throw new Error('update.enabled must be a boolean');
  if (raw.update.repositoryUrl !== undefined && (typeof raw.update.repositoryUrl !== 'string' || !raw.update.repositoryUrl.trim())) {
   throw new Error('update.repositoryUrl must be a non-empty string');
  }
  if (raw.update.branch !== undefined && (typeof raw.update.branch !== 'string' || !raw.update.branch.trim())) {
   throw new Error('update.branch must be a non-empty string');
  }
  if (raw.update.checkIntervalSeconds !== undefined && (!Number.isInteger(raw.update.checkIntervalSeconds) || raw.update.checkIntervalSeconds < 10 || raw.update.checkIntervalSeconds > 86400)) {
   throw new Error('update.checkIntervalSeconds must be 10..86400');
  }
  if (raw.update.statePath !== undefined && (typeof raw.update.statePath !== 'string' || !raw.update.statePath.trim())) {
   throw new Error('update.statePath must be a non-empty string');
  }
  if (raw.update.repoPath !== undefined && (typeof raw.update.repoPath !== 'string' || !raw.update.repoPath.trim())) {
   throw new Error('update.repoPath must be a non-empty string');
  }
  if (raw.update.publicationPath !== undefined && (typeof raw.update.publicationPath !== 'string' || !raw.update.publicationPath.trim())) {
   throw new Error('update.publicationPath must be a non-empty string');
  }
 }
 const resolvePath = p => (p.startsWith('/') ? p : path.resolve(path.dirname(absolute), p));
 const updateConfig = raw.update ? {
  enabled: Boolean(raw.update.enabled),
  repositoryUrl: raw.update.repositoryUrl ?? 'https://github.com/nuitsjp/token-monitor-analytics.git',
  branch: raw.update.branch ?? 'main',
  checkIntervalSeconds: raw.update.checkIntervalSeconds ?? 300,
  statePath: raw.update.statePath ? resolvePath(raw.update.statePath) : '/var/lib/tma-deploy/update-state.json',
  repoPath: raw.update.repoPath ? resolvePath(raw.update.repoPath) : '/var/lib/tma-deploy/repo',
  publicationPath: raw.update.publicationPath ? resolvePath(raw.update.publicationPath) : '/opt/token-monitor-analytics/publication.json'
 } : { enabled: false };
 if (raw.hubs !== undefined && raw.hubsPath !== undefined) {
  throw new Error('Cannot specify both hubs and hubsPath');
 }
 if (raw.hubs === undefined && raw.hubsPath === undefined) {
  throw new Error('Either hubs or hubsPath is required');
 }
 if (managementEnabled && !raw.hubsPath) {
  throw new Error('Management mode requires hubsPath');
 }

 const ids = new Set();
 let resolvedHubsPath = null;
 if (raw.hubsPath !== undefined) {
  if (typeof raw.hubsPath !== 'string' || !raw.hubsPath.trim()) throw new Error('hubsPath must be a non-empty string');
  if (path.isAbsolute(raw.hubsPath)) throw new Error('hubsPath must be a relative path');
  resolvedHubsPath = path.resolve(path.dirname(absolute), raw.hubsPath);
  const {hubsFile} = readHubsConfig(resolvedHubsPath);
  raw.hubs = hubsFile.hubs.map(h => ({id: h.id, label: h.label}));
  for (const hub of raw.hubs) {
   ids.add(hub.id);
  }
 } else {
  if (!Array.isArray(raw.hubs) || raw.hubs.length < 1 || raw.hubs.length > 16) throw new Error('Configure 1..16 hubs');
  for (const hub of raw.hubs) {
   keys(hub,['id','label'],'hub');
   if (!safeId(hub.id) || ids.has(hub.id) || typeof hub.label !== 'string' || !hub.label || hub.label.length > 128) throw new Error('Invalid/duplicate hub');
   ids.add(hub.id);
  }
 }

 if (!Array.isArray(raw.contracts)) throw new Error('contracts must be an array');
 const contractFields=['id','label','hubId','provider','accountKey','clientIds','deviceIds','windowKind','windowHours','monthlyFeeUsd','attributionConfirmed','minDeltaPercent','maxSourceSkewSeconds','maxGapSeconds'];
 for (const c of raw.contracts) {
  keys(c,contractFields,'contract');
  if (!safeId(c.id) || typeof c.attributionConfirmed !== 'boolean' || !Array.isArray(c.clientIds) || !Array.isArray(c.deviceIds) || ![...c.clientIds,...c.deviceIds].every(x=>typeof x==='string'&&x.length>0&&x.length<=256) || ![c.label,c.hubId,c.provider,c.accountKey,c.windowKind].every(x=>typeof x==='string'&&x.length>0&&x.length<=256)) throw new Error('Invalid contract identity');
 }
 validateContracts(raw.contracts,[...ids]);
 return {...raw,publicOrigin:origin.origin,databasePath:raw.databasePath.startsWith('/')?raw.databasePath:path.resolve(path.dirname(absolute),raw.databasePath),configFile:absolute,hubsPath:resolvedHubsPath,management:{enabled:managementEnabled},update:updateConfig};
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

export function isTailnetIPv4(ip){
 if(isIP(ip)!==4)return false;
 const parts=ip.split('.').map(Number);return parts[0]===100&&parts[1]>=64&&parts[1]<=127;
}
export function validateTailnetBinding(config,interfaces=networkInterfaces()){
 if(!config.tailnetViewer)return;
 if(!isTailnetIPv4(config.tailnetViewer.host)||!Object.entries(interfaces).some(([name,addresses])=>/^tailscale/i.test(name)&&addresses?.some(a=>a.address===config.tailnetViewer.host)))throw new Error('Configured Tailscale address is not assigned to a Tailscale interface; wait for Tailscale or rerun configure:ubuntu.');
}
