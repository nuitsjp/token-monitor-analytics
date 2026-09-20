import { initTRPC, TRPCError } from '@trpc/server';
import type { UsageOverview } from '../../contracts/usage-overview.ts';

const t = initTRPC.create();
export const appRouter = t.router({
  usageOverview: t.procedure.query((): UsageOverview => {
    throw new TRPCError({ code: 'NOT_IMPLEMENTED' });
  }),
});
export type AppRouter = typeof appRouter;
