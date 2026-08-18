import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { sentryVitePlugin } from '@sentry/vite-plugin';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false, // we provide our own via index.html link tag
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api'),
            handler: 'NetworkOnly',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
    // sentryVitePlugin must be LAST in the plugins array.
    // org/project are hardcoded, not read from process.env — vite.config.ts
    // sees only the shell environment, and the deploy script never sources
    // an .env file. The auth token is omitted entirely: the plugin reads
    // SENTRY_AUTH_TOKEN from client/.env.sentry-build-plugin on its own.
    sentryVitePlugin({
      org: 'vernal',
      project: 'vernal-web',
      sourcemaps: {
        filesToDeleteAfterUpload: ['./dist/**/*.map'],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3005',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: 'hidden',
  },
});
