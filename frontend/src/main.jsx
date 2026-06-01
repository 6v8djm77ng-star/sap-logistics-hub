import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import App from './App.jsx';
import { registerSW } from 'virtual:pwa-register';
import './index.css';

// PWA update guard. registerType:'autoUpdate' (vite.config) already swaps in a
// new Service Worker + reloads when one is found — but the browser only LOOKS
// for a new SW on navigation. A tab left open all day never navigates, so an
// operator could sit on a stale bundle for hours (exactly the 2026-05 incident
// where two operators stayed on the 08:13 build after two rebuilds). This polls
// for a new SW every 60s, so a fresh deploy is picked up — and auto-reloaded —
// within a minute, with no manual Ctrl+Shift+R. immediate:true registers right
// away instead of waiting for the load event.
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (registration) {
      setInterval(() => { registration.update().catch(() => {}); }, 60_000);
    }
  },
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Auto-refresh when user returns to the tab / window
      refetchOnWindowFocus: true,
      // Auto-refresh when network reconnects
      refetchOnReconnect: true,
      // Refetch when component remounts (page navigation)
      refetchOnMount: true,
      retry: 1,
    },
  },
});

// Expose the queryClient globally so the "Refresh" button in the header
// (and any other component) can invalidate every cached query at once.
if (typeof window !== 'undefined') {
  window.__queryClient = queryClient;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <App />
        <Toaster position="top-center" richColors dir="rtl" />
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>
);
