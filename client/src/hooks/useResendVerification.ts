// client/src/hooks/useResendVerification.ts
import { useState } from 'react';
import { post, apiErrorMessage } from '../lib/api';

// Sends a fresh verification link. onAlreadyVerified runs when the server
// says the address is already verified (nothing was sent).
export function useResendVerification(onAlreadyVerified: () => void) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    setError(null);
    setState('sending');
    try {
      const res = await post<{ data?: { sent?: boolean } }>('/api/me/verify-email/resend');
      if (res?.data?.sent === false) {
        setState('idle');
        onAlreadyVerified();
        return;
      }
      setState('sent');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not send the verification email.'));
      setState('idle');
    }
  }

  return { state, error, resend };
}
