import { RouterProvider } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import MergePrompt from './components/MergePrompt';
import router from './routes';

export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
      <MergePrompt />
    </AuthProvider>
  );
}
