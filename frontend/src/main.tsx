import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import '@mantine/core/styles.css';
import './style.css';
import { queryClient } from './features/query-client.ts';
import { router } from './app/router.ts';
createRoot(document.getElementById('root')!).render(<StrictMode>
<MantineProvider theme={{ primaryColor: 'teal', defaultRadius: 'md', fontFamily: 'Inter, "Yu Gothic UI", Meiryo, sans-serif' }}>
<QueryClientProvider client={queryClient}>
<RouterProvider router={router}/>
</QueryClientProvider>
</MantineProvider>
</StrictMode>);
