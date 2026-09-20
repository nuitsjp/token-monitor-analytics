import { QueryClient } from '@tanstack/react-query';
// SPAの1ブラウザ内だけのキャッシュ。サーバー側の利用者・DB状態とは別。
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false } } });
