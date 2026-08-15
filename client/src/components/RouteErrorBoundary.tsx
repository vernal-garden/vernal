import { useEffect } from 'react';
import { useRouteError, isRouteErrorResponse } from 'react-router-dom';
import * as Sentry from '@sentry/react';

export default function RouteErrorBoundary() {
  const error = useRouteError();

  useEffect(() => {
    // 404s and other thrown Responses are routing outcomes, not defects.
    if (isRouteErrorResponse(error)) return;
    Sentry.captureException(error);
  }, [error]);

  return <p className="p-4 text-red-500">Something went wrong. Please refresh.</p>;
}
