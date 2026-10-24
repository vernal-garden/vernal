import type { PoolClient } from 'pg';

export type AdminAction = 'account.role' | 'account.tier' | 'moderation.resolve' | 'feedback.status';
export type AdminTarget = 'account' | 'moderation_item' | 'feedback';

export interface AdminAuditEntry {
  adminId: number;
  action: AdminAction;
  targetType: AdminTarget;
  targetId: number;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

// Call inside the handler's transaction, after the change and before COMMIT,
// so the change and its log row commit or roll back together.
export async function recordAdminAction(client: PoolClient, entry: AdminAuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, before, after)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [entry.adminId, entry.action, entry.targetType, entry.targetId, entry.before, entry.after],
  );
}
