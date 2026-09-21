import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { subscribeUsageUpdates, usageOverviewQuery, type UsageConnectionStatus } from './usage-overview.ts';

const ConnectionContext = createContext<UsageConnectionStatus | null>(null);

export function useUsageOverview() {
  return useQuery(usageOverviewQuery);
}

export function useUsageConnectionStatus() {
  return useContext(ConnectionContext);
}

export function UsageUpdatesProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const { isSuccess } = useUsageOverview();
  const [status, setStatus] = useState<UsageConnectionStatus | null>(null);

  useEffect(() => {
    if (!isSuccess) return;
    return subscribeUsageUpdates(
      (overview) => {
        client.setQueryData(usageOverviewQuery.queryKey, overview);
      },
      setStatus,
    );
  }, [client, isSuccess]);

  return <ConnectionContext.Provider value={status}>{children}</ConnectionContext.Provider>;
}
