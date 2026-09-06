export type HubStatus = 'active' | 'disabled' | 'archived';

export interface ManagedHub {
  id: string;
  label: string;
  url: string;
  status: HubStatus;
  secretRef: string;
}

export interface HubsFile {
  schemaVersion: 1;
  revision: number;
  secretsPath: string;
  hubs: ManagedHub[];
}

export interface HubSecretsFile {
  schemaVersion: 1;
  secrets: Record<string, string>;
}

export interface HubViewItem {
  id: string;
  label: string;
  url: string;
  status: HubStatus;
  hasSecret: boolean;
}

export const MAX_CONFIG_BYTES = 262144;
export const MAX_ACTIVE_HUBS = 8;

export function isSafeId(x: unknown): x is string {
  return typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(x);
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return true;
  // Check 127.0.0.0/8
  const parts = hostname.split('.');
  if (parts.length === 4 && parts[0] === '127') {
    return parts.every(p => {
      const n = Number(p);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }
  return false;
}

export function validateHubUrl(urlStr: unknown): string {
  if (typeof urlStr !== 'string' || !urlStr.trim()) {
    throw new Error('Hub URL must be a non-empty string');
  }
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error('Hub URL is not a valid URL');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Hub URL must not contain authentication credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Hub URL must not contain query parameters or fragments');
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    throw new Error('Hub URL must not contain path segments');
  }
  if (parsed.protocol === 'http:') {
    if (!isLoopbackHostname(parsed.hostname)) {
      throw new Error('HTTP Hub URL is only permitted for loopback development');
    }
  } else if (parsed.protocol === 'https:') {
    // HTTPS is standard
  } else {
    throw new Error('Hub URL must use https: (or loopback http:)');
  }
  return parsed.origin;
}

export function validateHubsFile(content: unknown): HubsFile {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error('Hubs file must be an object');
  }
  const raw = content as Record<string, unknown>;
  const allowedKeys = ['schemaVersion', 'revision', 'secretsPath', 'hubs'];
  for (const k of Object.keys(raw)) {
    if (!allowedKeys.includes(k)) {
      throw new Error(`Unknown field in hubs file: ${k}`);
    }
  }
  if (raw.schemaVersion !== 1) {
    throw new Error('Hubs file schemaVersion must be 1');
  }
  if (!Number.isInteger(raw.revision) || (raw.revision as number) < 0) {
    throw new Error('Hubs file revision must be a non-negative integer');
  }
  if (typeof raw.secretsPath !== 'string' || !raw.secretsPath.trim()) {
    throw new Error('Hubs file secretsPath must be a non-empty string');
  }
  if (raw.secretsPath.startsWith('/') || raw.secretsPath.startsWith('\\') || /^[a-zA-Z]:/.test(raw.secretsPath)) {
    throw new Error('Hubs file secretsPath must be a relative path');
  }
  if (!Array.isArray(raw.hubs)) {
    throw new Error('Hubs file hubs must be an array');
  }

  const hubs: ManagedHub[] = [];
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  let nonArchivedCount = 0;

  const hubKeys = ['id', 'label', 'url', 'status', 'secretRef'];
  for (const item of raw.hubs) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Hub entry must be an object');
    }
    const h = item as Record<string, unknown>;
    for (const k of Object.keys(h)) {
      if (!hubKeys.includes(k)) {
        throw new Error(`Unknown field in hub entry: ${k}`);
      }
    }
    if (!isSafeId(h.id)) {
      throw new Error(`Invalid hub ID: ${String(h.id)}`);
    }
    if (seenIds.has(h.id)) {
      throw new Error(`Duplicate hub ID: ${h.id}`);
    }
    seenIds.add(h.id);

    if (typeof h.label !== 'string' || !h.label.trim() || h.label.length > 128) {
      throw new Error(`Hub label must be 1..128 characters for hub ${h.id}`);
    }
    const canonicalUrl = validateHubUrl(h.url);

    if (!['active', 'disabled', 'archived'].includes(h.status as string)) {
      throw new Error(`Hub status must be active, disabled or archived for hub ${h.id}`);
    }
    const status = h.status as HubStatus;

    if (typeof h.secretRef !== 'string' || !h.secretRef.trim() || h.secretRef.length > 64) {
      throw new Error(`Hub secretRef must be 1..64 characters for hub ${h.id}`);
    }

    if (status !== 'archived') {
      nonArchivedCount++;
      if (seenUrls.has(canonicalUrl)) {
        throw new Error(`Duplicate hub URL: ${canonicalUrl}`);
      }
      seenUrls.add(canonicalUrl);
    }

    hubs.push({
      id: h.id,
      label: h.label.trim(),
      url: canonicalUrl,
      status,
      secretRef: h.secretRef.trim()
    });
  }

  if (nonArchivedCount > MAX_ACTIVE_HUBS) {
    throw new Error(`Cannot configure more than ${MAX_ACTIVE_HUBS} non-archived hubs (found ${nonArchivedCount})`);
  }

  return {
    schemaVersion: 1,
    revision: raw.revision as number,
    secretsPath: raw.secretsPath,
    hubs
  };
}

export function validateHubSecretsFile(content: unknown): HubSecretsFile {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error('Secrets file must be an object');
  }
  const raw = content as Record<string, unknown>;
  const allowedKeys = ['schemaVersion', 'secrets'];
  for (const k of Object.keys(raw)) {
    if (!allowedKeys.includes(k)) {
      throw new Error(`Unknown field in secrets file: ${k}`);
    }
  }
  if (raw.schemaVersion !== 1) {
    throw new Error('Secrets file schemaVersion must be 1');
  }
  if (!raw.secrets || typeof raw.secrets !== 'object' || Array.isArray(raw.secrets)) {
    throw new Error('Secrets file secrets must be an object map');
  }
  const secretsMap = raw.secrets as Record<string, unknown>;
  const secrets: Record<string, string> = {};
  for (const [ref, val] of Object.entries(secretsMap)) {
    if (typeof ref !== 'string' || !ref.trim() || ref.length > 64) {
      throw new Error(`Invalid secret reference key: ${ref}`);
    }
    if (typeof val !== 'string' || !val || /[\r\n\0]/.test(val)) {
      throw new Error(`Invalid secret value for reference ${ref}: must be non-empty string without newlines or null bytes`);
    }
    secrets[ref] = val;
  }
  return {
    schemaVersion: 1,
    secrets
  };
}

export function toHubViewItems(hubs: ManagedHub[], secrets: Record<string, string>): HubViewItem[] {
  return hubs
    .filter(h => h.status !== 'archived')
    .map(h => ({
      id: h.id,
      label: h.label,
      url: h.url,
      status: h.status,
      hasSecret: Boolean(secrets[h.secretRef])
    }));
}
