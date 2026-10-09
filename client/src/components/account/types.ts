export interface AccountData {
  id: string;
  email: string;
  pendingEmail: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  emailVerified: boolean;
  zone: string;
  zoneLocationLabel: string;
  lastSpringFrostDate: string | null;
  firstFallFrostDate: string | null;
  role: 'user' | 'admin';
  subscriptionTier: 'free' | 'supporter';
  preferences: Record<string, unknown>;
  deletionScheduledAt: string | null;
  supporterPromptShown: boolean;
  isPasswordAccount: boolean;
  createdAt: string;
  updatedAt: string;
}
