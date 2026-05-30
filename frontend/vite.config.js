import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'SAP Logistics Hub',
        short_name: 'Logistics',
        description: 'מערכת תכנון לוגיסטי, הפצה וחזרות',
        theme_color: '#2563eb',
        background_color: '#ffffff',
        lang: 'he',
        dir: 'rtl',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/driver',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        // A2g-FIX-SW-AUTOUPDATE (2026-05-21): without skipWaiting+clientsClaim
        // a freshly-built SW sits in "waiting" state until ALL tabs of the
        // site close. Operators who keep a tab open all day never see new
        // bundles — they get whatever was cached on first visit. After the
        // 2026-05-20 parseWhitelist incident we found two operators on the
        // 08:13 bundle even though we'd rebuilt twice since.
        // skipWaiting: tell the new SW to activate immediately, no waiting.
        // clientsClaim: take control of already-open tabs on activation so
        // the very next fetch goes through the new SW (and thus new cache).
        // Trade-off: a page that's mid-load when an update lands can see a
        // mix of old/new chunks for one tick — acceptable for a tool with
        // no critical mid-flow state and a clear "reload" CTA in the
        // ErrorBoundary panel.
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            urlPattern: /\/api\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
          {
            // (2026-05-30) Navigation requests use NetworkFirst — without
            // this, the SW serves the precached index.html (with its old
            // hashed asset references) and a plain Ctrl+R still loads the
            // OLD bundle. Operators had to Ctrl+Shift+R after every deploy
            // to see the new code. With NetworkFirst here:
            //   - Soft refresh fetches a fresh index.html → points at new
            //     hashes → new bundle loads naturally.
            //   - Offline / slow → 3s timeout, then cache fallback (same
            //     behaviour as before, just with a bounded wait).
            // Pairs with skipWaiting+clientsClaim above — the new SW
            // installs immediately, then this rule makes sure the very
            // first navigation after install sees fresh HTML.
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'navigation-cache',
              networkTimeoutSeconds: 3,
            },
          },
        ],
      },
    }),
  ],
  build: {
    // Wipe the output dir before each build so old hashed bundles don't pile up
    // (was causing 46MB of stale assets in dist/).
    emptyOutDir: true,
    // Lift the warning threshold a bit since our biggest vendor chunk is large
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Code-split into separate vendor bundles so the user only downloads
        // what they need. Reduces first-paint from 1.2MB → ~400KB.
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'ui-vendor':    ['lucide-react', 'sonner', 'clsx'],
          'tanstack':     ['@tanstack/react-query'],
          'date-utils':   ['date-fns'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
});
