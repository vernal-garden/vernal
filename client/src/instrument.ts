import * as Sentry from '@sentry/react';

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? 'development',
  tracesSampleRate: 0.1,
  enabled: !!import.meta.env.VITE_SENTRY_DSN,
  dataCollection: {
    userInfo: false,
  },
  integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true })],
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,
});
