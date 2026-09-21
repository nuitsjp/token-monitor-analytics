import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyBaseLogger, FastifyReply } from 'fastify';
import type { UsageOverview } from '../../contracts/usage-overview.ts';

type RawResponse = FastifyReply['raw'];

type UsageStreamClient = {
    raw: RawResponse;
    pending: string | null;
    waitingForDrain: boolean;
    closed: boolean;
    onDrain: () => void;
    onClose: () => void;
    onError: () => void;
};

const INITIAL_READ_FAILURE_LOG = '利用状況の初回読み取りに失敗しました';
const PUBLISH_FAILURE_LOG = '利用状況の更新通知に失敗しました';
const UNAVAILABLE_MESSAGE = '利用状況を取得できませんでした。';

function toUpdateFrame(overview: UsageOverview): string {
    return `event: update\ndata: ${JSON.stringify(overview)}\n\n`;
}

export function createUsageStream(
    readOverview: () => UsageOverview,
    log: FastifyBaseLogger,
): {
    subscribe: (reply: FastifyReply) => void;
    publish: () => void;
    close: () => void;
} {
    const clients = new Set<UsageStreamClient>();
    let closed = false;

    const remove = (client: UsageStreamClient, destroy: boolean): void => {
        if (client.closed)
            return;
        client.closed = true;
        clients.delete(client);
        client.pending = null;
        client.raw.off('drain', client.onDrain);
        client.raw.off('close', client.onClose);
        client.raw.off('error', client.onError);
        if (destroy) {
            try {
                client.raw.destroy();
            }
            catch {
                // A failed client is already isolated from the stream.
            }
        }
    };

    const write = (client: UsageStreamClient, frame: string): void => {
        if (client.closed)
            return;
        if (client.waitingForDrain) {
            client.pending = frame;
            return;
        }
        try {
            const writable = client.raw.write(frame);
            if (!writable) {
                client.waitingForDrain = true;
                client.raw.once('drain', client.onDrain);
            }
        }
        catch {
            remove(client, true);
        }
    };

    const onDrain = (client: UsageStreamClient): void => {
        if (client.closed || !client.waitingForDrain)
            return;
        client.waitingForDrain = false;
        const pending = client.pending;
        client.pending = null;
        if (pending !== null)
            write(client, pending);
    };

    const subscribe = (reply: FastifyReply): void => {
        if (closed) {
            reply.code(503).send({ message: UNAVAILABLE_MESSAGE });
            return;
        }

        let frame: string;
        try {
            frame = toUpdateFrame(readOverview());
        }
        catch {
            log.error(INITIAL_READ_FAILURE_LOG);
            reply.code(503).send({ message: UNAVAILABLE_MESSAGE });
            return;
        }

        let client: UsageStreamClient | undefined;
        try {
            reply
                .header('Content-Type', 'text/event-stream')
                .header('Cache-Control', 'no-store')
                .header('Connection', 'keep-alive');
            const headers = reply.getHeaders() as OutgoingHttpHeaders;
            reply.hijack();

            client = {
                raw: reply.raw,
                pending: null,
                waitingForDrain: false,
                closed: false,
                onDrain: () => undefined,
                onClose: () => undefined,
                onError: () => undefined,
            };
            client.onDrain = () => onDrain(client as UsageStreamClient);
            client.onClose = () => remove(client as UsageStreamClient, false);
            client.onError = () => remove(client as UsageStreamClient, true);
            clients.add(client);
            client.raw.on('close', client.onClose);
            client.raw.on('error', client.onError);
            client.raw.writeHead(200, headers);
            write(client, frame);
        }
        catch {
            if (client)
                remove(client, true);
            else {
                try {
                    reply.raw.destroy();
                }
                catch {
                    // No response remains to clean up.
                }
            }
        }
    };

    const publish = (): void => {
        if (closed)
            return;
        let frame: string;
        try {
            frame = toUpdateFrame(readOverview());
        }
        catch {
            log.error(PUBLISH_FAILURE_LOG);
            for (const client of [...clients])
                remove(client, true);
            return;
        }
        for (const client of [...clients])
            write(client, frame);
    };

    const close = (): void => {
        if (closed)
            return;
        closed = true;
        for (const client of [...clients])
            remove(client, true);
    };

    return { subscribe, publish, close };
}
