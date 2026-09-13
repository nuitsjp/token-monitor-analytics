import { validateHeaderValue } from 'node:http';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { parseEstimationSettings } from './estimation-config.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const ENV_LINE_PATTERN = /^\s*(?:#.*|[A-Za-z_][A-Za-z0-9_]*\s*=.*)?$/;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class ConfigurationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ConfigurationError';
    this.code = code;
  }
}

function readText(filePath, errorCode) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    throw new ConfigurationError(errorCode);
  }
}

function readEnvironment(rootDir) {
  const text = readText(path.join(rootDir, '.env'), 'environment_file_unreadable');
  try {
    if (text.includes('\0') || text.split(/\r\n|\n|\r/).some((line) => !ENV_LINE_PATTERN.test(line))) {
      throw new Error('environment_file_invalid');
    }
    return parseEnv(text);
  } catch {
    throw new ConfigurationError('environment_file_invalid');
  }
}

function environmentValue(environment, fileEnvironment, key) {
  if (environment !== null && environment !== undefined && hasOwn(environment, key)) {
    if (environment[key] !== undefined) return environment[key];
  }
  return fileEnvironment[key];
}

function parseHost(value) {
  if (typeof value !== 'string') throw new ConfigurationError('host_invalid');
  const host = value.trim();
  if (!host || isIP(host) === 0) throw new ConfigurationError('host_invalid');
  return host;
}

function parsePort(value) {
  if (typeof value !== 'string') throw new ConfigurationError('port_invalid');
  const text = value.trim();
  if (!/^\d+$/.test(text)) throw new ConfigurationError('port_invalid');
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError('port_invalid');
  }
  return port;
}

function validateUrl(value) {
  if (typeof value !== 'string') return { value: null, error: 'invalid_url' };
  const url = value.trim();
  if (!url || !/^https?:\/\//i.test(url)) return { value: null, error: 'invalid_url' };

  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username
      || parsed.password
      || url.includes('?')
      || url.includes('#')
    ) {
      return { value: null, error: 'invalid_url' };
    }
  } catch {
    return { value: null, error: 'invalid_url' };
  }

  return { value: url, error: null };
}

function validateSecret(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    return { value: null, error: 'invalid_secret' };
  }

  try {
    validateHeaderValue('Authorization', `Bearer ${value}`);
  } catch {
    return { value: null, error: 'invalid_secret' };
  }

  return { value, error: null };
}

function readHubFile(rootDir) {
  const text = readText(path.join(rootDir, '.local', 'hubs.json'), 'configuration_file_unreadable');
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfigurationError('configuration_file_invalid_json');
  }
}

function parseHubs(document) {
  if (!isRecord(document)) throw new ConfigurationError('configuration_structure_invalid');
  if (!Array.isArray(document.hubs)) throw new ConfigurationError('hubs_array_invalid');

  const ids = new Set();
  return document.hubs.map((row) => {
    if (!isRecord(row)) throw new ConfigurationError('hub_row_invalid');
    if (Object.hasOwn(row, 'estimation')) throw new ConfigurationError('hub_estimation_must_be_top_level');

    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id) throw new ConfigurationError('hub_id_invalid');
    if (ids.has(id)) throw new ConfigurationError('hub_id_duplicate');
    ids.add(id);

    const url = validateUrl(row.url);
    const secret = validateSecret(row.secret);
    const errors = [url.error, secret.error].filter(Boolean);

    return {
      id,
      url: url.value,
      secret: secret.value,
      configError: errors.length > 0 ? errors.join(';') : null
    };
  });
}

export function loadConfiguration({ rootDir = process.cwd(), env = process.env, mode = 'real' } = {}) {
  if (mode !== 'real' && mode !== 'mock') {
    throw new ConfigurationError('mode_invalid');
  }

  const resolvedRoot = path.resolve(rootDir);
  const fileEnvironment = readEnvironment(resolvedRoot);
  const hostValue = environmentValue(env, fileEnvironment, 'ANALYTICS_HOST');
  const portValue = environmentValue(env, fileEnvironment, 'ANALYTICS_PORT');
  const host = parseHost(hostValue === undefined ? DEFAULT_HOST : hostValue);
  const port = parsePort(portValue === undefined ? String(DEFAULT_PORT) : portValue);

  const document = mode === 'real' ? readHubFile(resolvedRoot) : { hubs: [] };
  const hubs = parseHubs(document);
  const estimation = parseEstimationSettings(document.estimation);
  const configPath = mode === 'real'
    ? path.join(resolvedRoot, '.local', 'hubs.json')
    : null;

  return {
    mode,
    host,
    port,
    dbPath: path.join(resolvedRoot, 'data', mode, 'analytics.sqlite'),
    configPath,
    logPath: path.join(resolvedRoot, '.local', `${mode}.log`),
    hubs,
    estimation
  };
}
