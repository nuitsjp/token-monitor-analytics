import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Web から登録した接続設定の保存先。保存先の決定は呼び出し側が渡すパスだけに閉じる。
function readDocument(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { hubs: [] };
    throw error;
  }
  const document = JSON.parse(text);
  if (document === null || typeof document !== 'object' || Array.isArray(document) || !Array.isArray(document.hubs)) {
    throw new Error('hub registry document is invalid');
  }
  return document;
}

export function readHubRegistry(filePath) {
  return readDocument(filePath).hubs;
}

// 一時ファイルへ書いてから置き換える。途中で失敗しても部分的な設定を残さない。
export function appendHubRegistration(filePath, { id, url, secret }) {
  const document = readDocument(filePath);
  document.hubs = [...document.hubs, { id, url, secret }];
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    renameSync(temporary, filePath);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Keep the original write or rename error. */ }
    throw error;
  }
}
