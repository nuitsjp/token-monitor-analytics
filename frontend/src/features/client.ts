import { createTRPCClient, httpLink } from '@trpc/client';
import type { AppRouter } from '../../../backend/http/router.ts';
// import typeのみを跨ぐ。Node・SQL・秘密情報はブラウザへバンドルしない。
export const rpc = createTRPCClient<AppRouter>({ links: [httpLink({ url: '/api/trpc' })] });
