// Shared TypeScript types for the Vernal API.
// Application-specific types are defined in their respective route/service files.
// This file holds types that are reused across multiple modules.

export interface ApiResponse<T = void> {
  data?: T;
  error?: string;
}

// Extend Express Request to carry the authenticated session account.
// Populated by auth middleware in Phase 05. Declared here so TypeScript
// knows the shape before the middleware exists.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      account?: {
        id: number;
        email: string;
        role: 'user' | 'admin';
        subscriptionTier: 'free' | 'supporter';
      };
    }
  }
}
