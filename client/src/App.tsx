import * as Sentry from '@sentry/react';
import { RouterProvider } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import MergePrompt from './components/MergePrompt';
import router from './routes';

export default function App() {
  return (
    <Sentry.ErrorBoundary fallback={<p className="p-4 text-red-500">Something went wrong. Please refresh.</p>}>
      <AuthProvider>
        <RouterProvider router={router} />
        <MergePrompt />
      </AuthProvider>
    </Sentry.ErrorBoundary>
  );
}
