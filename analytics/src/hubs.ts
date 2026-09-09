export type HubStatus = 'active' | 'disabled' | 'archived';

export interface ManagedHub {
  id: string;
  label: string;
  url: string;
  status: HubStatus;
  secretRef: string;
}

/** A row returned by the SQLite Hub store.  Secret values never cross this boundary. */
// Archived SQLite rows remain queryable for history, but their reconnect
// material is deliberately cleared by migration 0004 and archiveHubRecord.
export interface HubRecord extends Omit<ManagedHub, 'url' | 'secretRef'> {
  url: string | null;
  secretRef: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastObservationAt: string | null;
}

export interface HubSecretsFile {
  schemaVersion: 1;
  secrets: Record<string, string>;
}

export const MAX_CONFIG_BYTES = 262144;

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
