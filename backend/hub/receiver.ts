import type { DatabaseSync } from 'node:sqlite';
import type { FastifyBaseLogger } from 'fastify';
import type { HubConnectionConfig } from './config-file.ts';
import { saveHubState, updateHubFreshness } from '../db/hub-state.ts';
import { parseHubNotification } from './protocol.ts';

// 接続は1回のみ。失敗後の再開はアプリケーションの再起動で行う。
export function startHubReceiver(config: HubConnectionConfig, db: DatabaseSync, log: FastifyBaseLogger): { stop: () => Promise<void> } {
    const controller = new AbortController();
    const done = receive(config, db, log, controller.signal).catch(() => {
        // 外部由来の例外・URL・応答本文には秘密情報が含まれ得るため出力しない。
        if (!controller.signal.aborted)
            log.error({ hubId: config.id, cause: 'connection' }, 'Hub受信を停止しました');
    }).finally(() => controller.abort());
    return { stop: async () => { controller.abort(); await done; } };
}

async function receive(config: HubConnectionConfig, db: DatabaseSync, log: FastifyBaseLogger, signal: AbortSignal): Promise<void> {
    const response = await fetch(new URL('/api/stats/stream', config.url), {
        headers: { Authorization: `Bearer ${config.token}`, Accept: 'text/event-stream', 'x-token-monitor-stream': '2' },
        redirect: 'error', signal,
    });
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
        await response.body?.cancel();
        log.error({ hubId: config.id, cause: 'response', status: response.status }, 'Hub受信を停止しました');
        return;
    }
    let initialReceived = false;
    let eventName = '';
    let data: string[] = [];
    let buffer = '';
    let skipLF = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const dispatch = (): boolean => {
        if (data.length === 0) { eventName = ''; return true; }
        const receivedAt = new Date().toISOString();
        let notification: ReturnType<typeof parseHubNotification>;
        try {
            notification = parseHubNotification(eventName, data.join('\n'));
            if (!initialReceived && notification.kind !== 'snapshot')
                throw new Error('初回はsnapshotが必要です');
        } catch {
            log.error({ hubId: config.id, cause: 'invalid-notification' }, 'Hub受信を停止しました');
            return false;
        }
        try {
            if (notification.kind === 'freshness')
                updateHubFreshness(db, config.id, notification.stats, receivedAt);
            else
                saveHubState(db, config.id, notification.stats, receivedAt);
        } catch {
            log.error({ hubId: config.id, cause: 'database' }, 'Hub受信を停止しました');
            return false;
        }
        initialReceived = true;
        log.info({ hubId: config.id, event: notification.kind, receivedAt }, 'Hubの最新状態を保存しました');
        eventName = '';
        data = [];
        return true;
    };
    const line = (value: string): boolean => {
        if (value === '') return dispatch();
        if (value.startsWith(':')) return true;
        const colon = value.indexOf(':');
        const field = colon < 0 ? value : value.slice(0, colon);
        let contents = colon < 0 ? '' : value.slice(colon + 1);
        if (contents.startsWith(' ')) contents = contents.slice(1);
        if (field === 'event') eventName = contents;
        if (field === 'data') data.push(contents);
        return true;
    };
    // CR/LF/CRLFとUTF-8の分割はネットワークchunk境界に依存させない。
    for await (const chunk of response.body) {
        const text = decoder.decode(chunk, { stream: true });
        for (const character of text) {
            if (skipLF) { skipLF = false; if (character === '\n') continue; }
            if (character === '\r' || character === '\n') {
                if (!line(buffer)) return;
                buffer = '';
                skipLF = character === '\r';
            } else buffer += character;
        }
    }
    decoder.decode();
    if (!signal.aborted)
        log.error({ hubId: config.id, cause: 'disconnected' }, 'Hub受信を停止しました');
}
