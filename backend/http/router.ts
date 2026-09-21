import { initTRPC } from '@trpc/server';
import type { DatabaseSync } from 'node:sqlite';
import { readHubDeviceOverview } from '../db/hub-state.ts';
import type { HubConnectionConfig } from '../hub/config-file.ts';

const t = initTRPC.create();
export function createAppRouter(db: DatabaseSync, hubs: readonly HubConnectionConfig[]) {
  return t.router({
    usageOverview: t.procedure.query(() => ({ hubs: readHubDeviceOverview(db, hubs) })),
  });
}
export type AppRouter = ReturnType<typeof createAppRouter>;
