// Types for the admin API (/api/admin, admin role only), shaped exactly as the
// server returns them. /accounts and /accounts/:id are snake_case; the rest
// are camelCase.
import { get, patch } from './api';

const BASE = '/api/admin';

// ── Accounts ─────────────────────────────────────────────────────────────────

export type AccountRole = 'user' | 'admin';
export type SubscriptionTier = 'free' | 'supporter';
export type SubscriptionInterval = 'monthly' | 'annual' | 'lifetime';

export interface AccountRow {
  id: number;
  email: string;
  display_name: string | null;
  role: AccountRole;
  subscription_tier: SubscriptionTier;
  subscription_interval: SubscriptionInterval | null;
  subscription_period_end: string | null;
  last_active_at: string | null;
  created_at: string;
}

/** GET /accounts?page=N */
export interface AccountsPage {
  data: AccountRow[];
  page: number;
  total: number;
}

/** GET /accounts?email=x (max 20, no paging) */
export interface AccountsSearch {
  data: AccountRow[];
}

/** GET /accounts/:id */
export interface AccountDetail extends AccountRow {
  zone: string | null;
  zone_location_label: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_cancelled_at: string | null;
  updated_at: string;
  gardenCount: number;
}

/** PATCH /accounts/:id/tier */
export interface TierUpdateResponse {
  id: number;
  subscriptionTier: SubscriptionTier;
}

/** PATCH /accounts/:id/role */
export interface RoleUpdateResponse {
  id: number;
  role: AccountRole;
}

// ── Seeds ────────────────────────────────────────────────────────────────────

/** GET /seeds/summary */
export interface SeedsSummary {
  totalSeeds: number;
  communitySeeds: number;
  pendingModeration: number;
  addedThisMonth: number;
}

export type SeedSource = 'cambium' | 'community';
export type SeedSortKey =
  | 'common_name'
  | 'scientific_name'
  | 'plant_family'
  | 'source'
  | 'open_corrections'
  | 'created_at';
export type SortDir = 'asc' | 'desc';

export interface AdminSeedRow {
  id: number;
  commonName: string;
  scientificName: string | null;
  plantFamily: string | null;
  source: SeedSource;
  rawSource: string;
  moderationStatus: string;
  openCorrections: number;
  createdAt: string;
}

/** GET /seeds */
export interface AdminSeedsPage {
  data: AdminSeedRow[];
  page: number;
  total: number;
}

// ── Moderation ───────────────────────────────────────────────────────────────

export type ModerationTab = 'all' | 'corrections' | 'new_seeds' | 'resolved';
export type ModerationType = 'correction' | 'new_seed';
export type ModerationStatus = 'new' | 'under_review' | 'approved' | 'rejected';
export type ModerationAction = 'approve' | 'reject' | 'defer';

export interface ModerationRow {
  id: number;
  type: ModerationType;
  status: ModerationStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  seedName: string | null;
  submitterName: string | null;
}

export interface ModerationCounts {
  all: number;
  corrections: number;
  newSeeds: number;
  resolved: number;
}

/** GET /moderation */
export interface ModerationList {
  tab: ModerationTab;
  data: ModerationRow[];
  counts: ModerationCounts;
  page: number;
  total: number;
}

/** GET /moderation/:id */
export interface ModerationDetail {
  id: number;
  type: ModerationType;
  status: ModerationStatus;
  content: Record<string, unknown>;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
  seedName: string | null;
  seed: null | {
    id: number;
    commonName: string;
    scientificName: string | null;
    contributionStatus?: string;
  };
  submitter: null | {
    id: number;
    displayName: string | null;
    email: string;
  };
}

/** PATCH /moderation/:id */
export interface ModerationActionResponse {
  id: number;
  status: ModerationStatus;
  resolutionNote: string | null;
  resolvedAt: string | null;
}

// ── Users ────────────────────────────────────────────────────────────────────

/** GET /users/summary */
export interface UsersSummary {
  totalUsers: number;
  active30d: number;
  freeActive30d: number;
  paidSubscribers: number;
  lifetime: number;
  supporters: number;
  newSignups7d: number;
  newSignups30d: number;
  churned30d: number;
  /** Fraction 0..1. */
  upgradeRate30d: number | null;
  activeGuestSessions7d: number;
}

export type UsersChartRange = '30d' | '90d' | 'all';

/** GET /users/charts */
export interface UsersCharts {
  range: UsersChartRange;
  userGrowth: Array<{ bucket: string; totalUsers: number }>;
  tierBySignupMonth: Array<{ month: string; free: number; paid: number; lifetime: number; comped: number }>;
}

// ── Features ─────────────────────────────────────────────────────────────────

export interface FeatureUsage {
  key: string;
  label: string;
  tier: string;
  uses: number;
  users: number;
  /** Integer percent 0..100. */
  pctOfActive: number;
}

export interface MicroFeedbackStat {
  triggerKey: string;
  label: string;
  timesFired: number;
  responses: number;
  /** Fraction 0..1. */
  responseRate: number | null;
}

/** GET /features */
export interface FeaturesReport {
  activeUsers30d: number;
  headline: { canvasSessions: number; harvestEntries: number; plantingGuideEntries: number };
  features: FeatureUsage[];
  microFeedback: MicroFeedbackStat[];
}

// ── Feedback ─────────────────────────────────────────────────────────────────

export type FeedbackStatus = 'new' | 'reviewed' | 'closed';
export type FeedbackStatusFilter = 'active' | 'new' | 'reviewed' | 'closed' | 'everything';
export type FeedbackCategory = 'bug' | 'feature_request' | 'general' | 'data_quality';

export interface FeedbackRow {
  id: number;
  category: FeedbackCategory;
  /** First 120 characters of the message. */
  preview: string;
  sourceSurface: string | null;
  appVersion: string | null;
  status: FeedbackStatus;
  createdAt: string;
  userLabel: string | null;
}

/** GET /feedback */
export interface FeedbackList {
  data: FeedbackRow[];
  page: number;
  total: number;
  counts: { new: number; reviewed: number; closed: number };
  surfaces: string[];
}

/** GET /feedback/:id */
export interface FeedbackDetail {
  id: number;
  userId: number | null;
  category: FeedbackCategory;
  message: string;
  sourceSurface: string | null;
  appVersion: string | null;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
  user: null | { id: number; displayName: string | null; email: string };
}

/** PATCH /feedback/bulk */
export interface FeedbackBulkResponse {
  updated: number[];
}

/** PATCH /feedback/:id */
export interface FeedbackUpdateResponse {
  id: number;
  status: FeedbackStatus;
  updatedAt: string;
}

// ── System ───────────────────────────────────────────────────────────────────

export type SystemStatus = 'operational' | 'degraded' | 'outage';
export type JobState = 'never' | 'failed' | 'stale' | 'ok';

export interface JobHealth {
  jobKey: string;
  label: string;
  state: JobState;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastOkAt: string | null;
  errorMsg: string | null;
}

export interface RequestHour {
  hourStart: string;
  count: number;
  errors5xx: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number;
}

/** GET /system */
export interface SystemReport {
  status: SystemStatus;
  database: { ok: boolean; latencyMs: number | null };
  jobs: JobHealth[];
  requestMetrics: {
    since: string;
    hours: RequestHour[];
    lastFullHour: null | {
      count: number;
      /** Fraction 0..1. */
      errorRate: number;
      p50Ms: number | null;
      p95Ms: number | null;
    };
  };
  sentry: { issuesUrl: string | null; performanceUrl: string | null };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Builds a query string, dropping undefined / null / empty-string values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// get/patch return `T | undefined` only for 204s, which these endpoints never send.
async function aget<T>(path: string): Promise<T> {
  return (await get<T>(`${BASE}${path}`)) as T;
}
async function apatch<T>(path: string, body: unknown): Promise<T> {
  return (await patch<T>(`${BASE}${path}`, body)) as T;
}

export const adminApi = {
  accounts: (page: number) => aget<AccountsPage>(`/accounts${qs({ page })}`),
  searchAccounts: (email: string) => aget<AccountsSearch>(`/accounts${qs({ email })}`),
  account: (id: number) => aget<AccountDetail>(`/accounts/${id}`),
  setTier: (id: number, tier: SubscriptionTier) => apatch<TierUpdateResponse>(`/accounts/${id}/tier`, { tier }),
  setRole: (id: number, role: AccountRole) => apatch<RoleUpdateResponse>(`/accounts/${id}/role`, { role }),

  seedsSummary: () => aget<SeedsSummary>('/seeds/summary'),
  seeds: (params: {
    q?: string;
    source?: SeedSource;
    hasCorrections?: boolean;
    sort?: SeedSortKey;
    dir?: SortDir;
    page?: number;
  }) => aget<AdminSeedsPage>(`/seeds${qs({ ...params, hasCorrections: params.hasCorrections ? 'true' : undefined })}`),

  moderation: (tab: ModerationTab, page?: number) =>
    aget<ModerationList>(`/moderation${qs({ tab, page: tab === 'resolved' ? page : undefined })}`),
  moderationItem: (id: number) => aget<ModerationDetail>(`/moderation/${id}`),
  moderate: (id: number, action: ModerationAction, note?: string) =>
    apatch<ModerationActionResponse>(`/moderation/${id}`, note ? { action, note } : { action }),

  usersSummary: () => aget<UsersSummary>('/users/summary'),
  usersCharts: (range: UsersChartRange) => aget<UsersCharts>(`/users/charts${qs({ range })}`),

  features: () => aget<FeaturesReport>('/features'),

  feedback: (params: {
    status?: FeedbackStatusFilter;
    category?: FeedbackCategory;
    surface?: string;
    page?: number;
  }) => aget<FeedbackList>(`/feedback${qs(params)}`),
  feedbackItem: (id: number) => aget<FeedbackDetail>(`/feedback/${id}`),
  setFeedbackStatus: (id: number, status: 'reviewed' | 'closed') =>
    apatch<FeedbackUpdateResponse>(`/feedback/${id}`, { status }),
  bulkFeedbackStatus: (ids: number[], status: 'reviewed' | 'closed') =>
    apatch<FeedbackBulkResponse>('/feedback/bulk', { ids, status }),

  system: () => aget<SystemReport>('/system'),
};

/** Pulls `{ error }` out of an ApiError body, with a fallback message. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'body' in err) {
    const body = (err as { body: unknown }).body;
    if (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string') {
      return (body as { error: string }).error;
    }
  }
  return fallback;
}
