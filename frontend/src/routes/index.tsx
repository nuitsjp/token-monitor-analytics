import { createFileRoute } from '@tanstack/react-router';
import { Alert, Card, Group, SimpleGrid, Skeleton, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { HubUsageOverview } from '../../../contracts/usage-overview.ts';
import { getUsageOverview } from '../features/usage-overview.ts';
import classes from './index.module.css';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  const overview = useQuery({
    queryKey: ['usage-overview'],
    queryFn: getUsageOverview,
    staleTime: Infinity,
  });

  return (
    <Stack gap="lg">
      {overview.isPending ? (
        <LoadingCards />
      ) : overview.isError ? (
        <Alert color="red" title="取得エラー">
          利用状況を取得できませんでした
        </Alert>
      ) : (
        <Stack gap="lg">
          <UsageTotal hubs={overview.data.hubs} />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            {overview.data.hubs.map((hub) => (
              <UsageCard key={hub.hubId} hub={hub} />
            ))}
          </SimpleGrid>
        </Stack>
      )}
    </Stack>
  );
}

function LoadingCards() {
  return (
    <Stack gap="md">
      <Skeleton height={128} radius="lg" />
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        <Skeleton height={190} radius="lg" />
        <Skeleton height={190} radius="lg" />
      </SimpleGrid>
    </Stack>
  );
}

function UsageTotal({ hubs }: { hubs: HubUsageOverview[] }) {
  const totals = hubs.reduce(
    (result, hub) => {
      if (hub.usage) {
        result.todayTokens += hub.usage.todayTokens;
        result.todayCostUsd += hub.usage.todayCostUsd;
        result.deviceCount += hub.usage.deviceCount;
        result.receivedHubCount += 1;
      }
      return result;
    },
    { todayTokens: 0, todayCostUsd: 0, deviceCount: 0, receivedHubCount: 0 },
  );

  return (
    <Card className={classes.overview} padding="lg" radius="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-end">
          <div>
            <Text className={classes.eyebrow}>Token Monitor Analytics</Text>
            <Title order={1} className={classes.overviewTitle}>
              利用状況
            </Title>
          </div>
          <Text className={classes.totalContext}>
            受信済み {totals.receivedHubCount} / 登録 {hubs.length} Hub
          </Text>
        </Group>
        <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="lg">
          <TotalMetric label="今日の使用トークン数" value={totals.todayTokens.toLocaleString()} />
          <TotalMetric label="今日の推定コスト" value={`$${totals.todayCostUsd.toFixed(2)}`} />
          <TotalMetric label="端末数" value={`${totals.deviceCount.toLocaleString()}台`} />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}

function TotalMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text className={classes.totalLabel}>{label}</Text>
      <Text className={classes.totalValue}>{value}</Text>
    </div>
  );
}

function UsageCard({ hub }: { hub: HubUsageOverview }) {
  return (
    <Card className={classes.card} padding="lg" radius="lg" withBorder>
      <Stack gap="md">
        <Title order={2} className={classes.hubName}>
          {hub.name}
        </Title>
        {hub.usage ? (
          <AvailableUsage usage={hub.usage} />
        ) : (
          <Text c="dimmed" className={classes.pending}>
            まだ情報を受信していません
          </Text>
        )}
      </Stack>
    </Card>
  );
}

function AvailableUsage({ usage }: { usage: NonNullable<HubUsageOverview['usage']> }) {
  return (
    <Stack gap="md">
      <div>
        <Text size="sm" c="dimmed">
          今日の使用トークン数
        </Text>
        <Text className={classes.primaryValue}>{usage.todayTokens.toLocaleString()}</Text>
      </div>
      <Group grow align="flex-start" gap="lg">
        <Metric label="今日の推定コスト" value={`$${usage.todayCostUsd.toFixed(2)}`} />
        <Metric label="端末数" value={`${usage.deviceCount.toLocaleString()}台`} />
      </Group>
      <Text size="sm" c="dimmed">
        データ更新日時: {formatUpdatedAt(usage.updatedAt)}
      </Text>
    </Stack>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text fw={700} size="xl">
        {value}
      </Text>
    </div>
  );
}

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
}
