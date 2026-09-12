import { resolve } from 'node:path';

export function readConfig(env = process.env) {
  for (const name of ['BASIC_USER', 'BASIC_PASSWORD', 'HUB_ID', 'HUB_URL', 'HUB_SECRET']) {
    if (!env[name]?.trim()) throw new Error(`${name} を .env に設定してください。`);
  }
  if (env.BASIC_USER.includes(':') || /[\r\n]/.test(env.BASIC_USER + env.BASIC_PASSWORD + env.HUB_SECRET)) {
    throw new Error('認証設定に使用できない文字が含まれています。');
  }
  let url;
  try { url = new URL(env.HUB_URL); } catch { throw new Error('HUB_URL の形式が不正です。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('HUB_URL は認証情報・クエリ・フラグメントを含まない HTTP(S) URL にしてください。');
  }
  const port = Number(env.PORT || 17322);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT は 1〜65535 の整数にしてください。');
  return {
    host: env.HOST || '127.0.0.1', port,
    databasePath: resolve(env.DATABASE_PATH || 'data/analytics.sqlite'),
    username: env.BASIC_USER, password: env.BASIC_PASSWORD,
    hub: { id: env.HUB_ID, name: env.HUB_NAME || env.HUB_ID, url: url.href.replace(/\/$/, ''), secret: env.HUB_SECRET }
  };
}
