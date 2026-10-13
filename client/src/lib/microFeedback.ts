import { useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { patch, post } from './api';

// Contextual micro-feedback prompts (Feedback Pipeline spec surface 3.2).
// The server decides whether a prompt is shown (once per account per trigger);
// at most one is shown per page load. Nothing here may throw into UI code.

export type MicroFeedbackTrigger = 'planted' | 'first_sowing' | 'harvest_logged' | 'cross_season' | 'upgrade';

export const PROMPTS: Record<MicroFeedbackTrigger, { question: string; type: 'thumbs' | 'text' }> = {
  planted: { question: 'Was placing your first plant easy to figure out?', type: 'thumbs' },
  first_sowing: { question: 'Does the planting guide show you what you need?', type: 'thumbs' },
  harvest_logged: { question: 'How did logging your harvest feel?', type: 'thumbs' },
  cross_season: { question: 'Is this comparison useful for planning your next season?', type: 'thumbs' },
  upgrade: { question: 'What made you decide to upgrade?', type: 'text' },
};

type Listener = (trigger: MicroFeedbackTrigger) => void;

let shownThisSession = false;
let pending = false;
let listener: Listener | null = null;

// The host registers itself; returns the unregister function.
export function setMicroFeedbackListener(next: Listener): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}

function requestPrompt(trigger: MicroFeedbackTrigger): void {
  try {
    if (shownThisSession || pending || !listener) return;
    pending = true;
    post<{ show: boolean }>('/api/micro-feedback/shown', { triggerKey: trigger })
      .then((res) => {
        if (res?.show) {
          shownThisSession = true;
          listener?.(trigger);
        }
      })
      .catch(() => {})
      .finally(() => {
        pending = false;
      });
  } catch {
    pending = false;
  }
}

// request(trigger) is fire-and-forget: never await it, it never throws.
export function useMicroFeedback(): (trigger: MicroFeedbackTrigger) => void {
  const { isAccount } = useAuth();
  const isAccountRef = useRef(isAccount);
  isAccountRef.current = isAccount;

  return useCallback((trigger: MicroFeedbackTrigger) => {
    if (isAccountRef.current) requestPrompt(trigger);
  }, []);
}

export async function sendMicroFeedback(trigger: MicroFeedbackTrigger, response: string): Promise<number> {
  const res = await post<{ id: number }>('/api/micro-feedback', { triggerKey: trigger, response });
  return res!.id;
}

export async function sendMicroFeedbackComment(id: number, comment: string): Promise<void> {
  await patch(`/api/micro-feedback/${id}`, { comment });
}
