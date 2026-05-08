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
