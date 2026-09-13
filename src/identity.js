import { createHash } from 'node:crypto';

export function deviceKey(hubId, deviceId) {
  return JSON.stringify([hubId, deviceId]);
}

export function contractScope() {
  return '';
}

export function contractAccountKey(provider) {
  if (provider.provider !== 'grok') return provider.accountKey || null;
  const email = provider.accountEmail?.trim().toLowerCase();
  return email ? `email:${createHash('sha256').update(email).digest('hex')}` : null;
}

export function providerContractId(provider, hubId) {
  const accountKey = contractAccountKey(provider);
  return accountKey ? contractId(provider.provider, accountKey, hubId) : null;
}

export function contractId(provider, accountKey, hubId) {
  return createHash('sha256')
    .update(JSON.stringify([contractScope(provider, hubId), provider, accountKey]))
    .digest('hex');
}
