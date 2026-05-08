import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import App from './App.jsx';
import './index.css';

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
