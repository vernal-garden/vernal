// Shared TypeScript types for the Vernal API.

export interface ApiResponse<T = void> {
  data?: T;
  error?: string;
}

// Session attached to every request by src/middleware/session.ts
export interface SessionData {
  id: string;           // guest_sessions.id (UUID)
  token: string;        // the raw session token (stored in cookie)
  isGuest: boolean;     // true when account_id IS NULL
  expiresAt: Date;
  account: SessionAccount | null;
}

export interface SessionAccount {
  id: number;
  email: string;
  role: 'user' | 'admin';
  subscriptionTier: 'free' | 'supporter';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session: SessionData | null;  // null = no valid session cookie
    }
  }
}
