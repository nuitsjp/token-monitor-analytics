import { readFileSync } from 'node:fs';
import { z } from 'zod';

export interface HubConnectionConfig {
    id: string;
    name: string;
    url: string;
    token: string;
}

const hubSchema = z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    url: z.string().trim().min(1),
    token: z.string().trim().min(1).refine(value => !/[\r\n]/.test(value)),
}).strict();

const configSchema = z.object({
    hubs: z.array(hubSchema).length(2),
}).strict();

export function readHubConfigFile(path: string): HubConnectionConfig[] {
    let document: unknown;
    try {
        document = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        throw new Error('Hub接続設定ファイルを読み込めません。');
    }

    const result = configSchema.safeParse(document);
    if (!result.success)
        throw new Error('Hub接続設定ファイルの形式が不正です。');

    const ids = new Set(result.data.hubs.map(hub => hub.id));
    if (ids.size !== result.data.hubs.length)
        throw new Error('Hub接続設定ファイルのHub IDが重複しています。');

    return result.data.hubs.map(hub => ({ ...hub, url: normalizeOrigin(hub.url) }));
}

function normalizeOrigin(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('Hub接続設定ファイルのURLが不正です。');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('Hub接続設定ファイルのURLが不正です。');
    }
    return url.origin;
}
