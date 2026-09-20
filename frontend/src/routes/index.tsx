import { createFileRoute } from '@tanstack/react-router';
import { Stack, Text, Title } from '@mantine/core';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
    return <Stack gap="md">
        <Title order={1}>Token Monitor Analytics</Title>
        <Text c="dimmed">準備中です。</Text>
    </Stack>;
}
