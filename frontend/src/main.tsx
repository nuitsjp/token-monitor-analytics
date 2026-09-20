import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import '@mantine/core/styles.css';
import './style.css';
import { queryClient } from './features/query-client.ts';
import { router } from './app/router.ts';
import { cssVariablesResolver, theme } from './app/theme.ts';
createRoot(document.getElementById('root')!).render(<StrictMode>
<MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
<QueryClientProvider client={queryClient}>
<RouterProvider router={router}/>
</QueryClientProvider>
</MantineProvider>
</StrictMode>);
