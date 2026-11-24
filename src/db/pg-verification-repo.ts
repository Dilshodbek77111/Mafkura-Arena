import type { PoolClient } from 'pg';
import { Db, uniqueViolation } from './db';
import { UserStatus } from '../auth/ports';
import { AuditWriter, AttemptRecord, NewDocument, PendingItem, UserNotifier, VerificationRepo, VerificationState } from '../verification/ports';
import { VerificationError } from '../verification/verification.service';
import { randomUUID } from 'node:crypto';

type AttemptRow = { id: number; user_id: number; attempt_no: number; status: AttemptRecord['status']; submitted_at: Date; reject_reason: string | null };
const toAttempt = (r: AttemptRow): AttemptRecord => ({
  id: r.id, userId: r.user_id, attemptNo: r.attempt_no, status: r.status, submittedAt: r.submitted_at, rejectReason: r.reject_reason,
});

export class PgVerificationRepo implements VerificationRepo {
  constructor(private readonly db: Db) {}

  async getState(userId: number): Promise<VerificationState | null> {
    const r = await this.db.query(
      `SELECT u.id, u.status, u.phone_verified_at, v.attempts_used, v.extra_attempts
       FROM users u JOIN user_verifications v ON v.user_id = u.id WHERE u.id = $1`, [userId]);
    const x = r.rows[0];
    return x ? { userId: x.id, userStatus: x.status, attemptsUsed: x.attempts_used, extraAttempts: x.extra_attempts, phoneVerified: x.phone_verified_at !== null } : null;
  }
  async findPendingAttempt(userId: number) {
    const r = await this.db.query<AttemptRow>("SELECT * FROM verification_attempts WHERE user_id=$1 AND status='PENDING'", [userId]);
    return r.rows[0] ? toAttempt(r.rows[0]) : null;
  }
  async getAttempt(id: number) {
    const r = await this.db.query<AttemptRow>('SELECT * FROM verification_attempts WHERE id=$1', [id]);
    return r.rows[0] ? toAttempt(r.rows[0]) : null;
  }
  async createAttempt(userId: number, attemptNo: number, doc: NewDocument): Promise<AttemptRecord> {
    try {
      return await this.db.tx(async (c) => {
        await c.query('SELECT 1 FROM user_verifications WHERE user_id=$1 FOR UPDATE', [userId]); // bir foydalanuvchining so'rovlarini ketma-ketlashtiradi
        const a = await c.query('INSERT INTO verification_attempts (user_id, attempt_no) VALUES ($1,$2) RETURNING *', [userId, attemptNo]);
        await c.query(
          `INSERT INTO verification_documents (attempt_id, storage_key, mime, size_bytes, sha256, retention_until)
           VALUES ($1,$2,$3,$4,$5,$6)`, [a.rows[0].id, doc.storageKey, doc.mime, doc.sizeBytes, doc.sha256, doc.retentionUntil]);
        await c.query("UPDATE user_verifications SET attempts_used = attempts_used + 1, doc_status='PENDING' WHERE user_id=$1", [userId]);
        return toAttempt(a.rows[0]);
      });
    } catch (e) {
      const k = uniqueViolation(e);
      if (k === 'verification_attempts_one_pending' || k === 'verification_attempts_user_no_key') throw new VerificationError('PENDING_EXISTS');
      throw e;
    }
  }
  async decide(attemptId: number, d: { status: 'APPROVED' | 'REJECTED'; reason?: string; adminId: number; at: Date; retentionUntil: Date; newUserStatus: UserStatus }) {
    return this.db.tx(async (c) => {
      const r = await c.query(
        `UPDATE verification_attempts SET status=$2, reject_reason=$3, reviewed_at=$4, reviewed_by=$5
         WHERE id=$1 AND status='PENDING' RETURNING user_id`, [attemptId, d.status, d.reason ?? null, d.at, d.adminId]);
      if (r.rowCount === 0) return false; // boshqa admin oldin qaror chiqargan
      const userId = r.rows[0].user_id;
      await c.query('UPDATE verification_documents SET retention_until=$2 WHERE attempt_id=$1', [attemptId, d.retentionUntil]);
      await c.query('UPDATE user_verifications SET doc_status=$2 WHERE user_id=$1', [userId, d.status]);
      await c.query('UPDATE users SET status=$2, updated_at=now() WHERE id=$1', [userId, d.newUserStatus]);
      return true;
    });
  }
  async getDocument(id: number) {
    const r = await this.db.query(
      `SELECT d.id, d.attempt_id, a.user_id, d.storage_key FROM verification_documents d
       JOIN verification_attempts a ON a.id = d.attempt_id WHERE d.id=$1 AND d.deleted_at IS NULL`, [id]);
    const x = r.rows[0];
    return x ? { id: x.id, attemptId: x.attempt_id, userId: x.user_id, storageKey: x.storage_key } : null;
  }
  async grantExtraAttempt(userId: number) {
    await this.db.tx(async (c) => {
      await c.query('UPDATE user_verifications SET extra_attempts = extra_attempts + 1 WHERE user_id=$1', [userId]);
      await c.query("UPDATE users SET status='DOC_REJECTED', updated_at=now() WHERE id=$1 AND status='BLOCKED'", [userId]);
    });
  }
  async getLatestAttempt(userId: number) {
    const r = await this.db.query<AttemptRow>('SELECT * FROM verification_attempts WHERE user_id=$1 ORDER BY attempt_no DESC LIMIT 1', [userId]);
    return r.rows[0] ? toAttempt(r.rows[0]) : null;
  }
  async listPending(limit: number): Promise<PendingItem[]> {
    const r = await this.db.query(
      `SELECT a.id AS attempt_id, a.user_id, a.attempt_no, a.submitted_at, d.id AS document_id, u.first_name, u.last_name
       FROM verification_attempts a JOIN users u ON u.id = a.user_id JOIN verification_documents d ON d.attempt_id = a.id
       WHERE a.status = 'PENDING' AND d.deleted_at IS NULL ORDER BY a.submitted_at ASC LIMIT $1`, [limit]);
    return r.rows.map((x) => ({ attemptId: x.attempt_id, userId: x.user_id, attemptNo: x.attempt_no, submittedAt: x.submitted_at,
      documentId: x.document_id, firstName: x.first_name, lastName: x.last_name }));
  }
  async listExpiredDocuments(now: Date) {
    const r = await this.db.query('SELECT id, storage_key FROM verification_documents WHERE deleted_at IS NULL AND retention_until <= $1', [now]);
    return r.rows.map((x) => ({ id: x.id, storageKey: x.storage_key }));
  }
  async markDocumentDeleted(id: number, at: Date) { await this.db.query('UPDATE verification_documents SET deleted_at=$2 WHERE id=$1', [id, at]); }
}

export class PgAuditWriter implements AuditWriter {
  constructor(private readonly db: Db) {}
  async write(e: { adminId: number | null; action: string; objectType: string; objectId: string; oldValue?: unknown; newValue?: unknown; reason?: string }, client?: PoolClient) {
    const sql = 'INSERT INTO admin_audit_log (admin_id, action, object_type, object_id, old_value, new_value, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)';
    const values = [e.adminId, e.action, e.objectType, e.objectId,
      e.oldValue === undefined ? null : JSON.stringify(e.oldValue), e.newValue === undefined ? null : JSON.stringify(e.newValue), e.reason ?? null];
    if (client) await client.query(sql, values);
    else await this.db.query(sql, values);
  }
}

const TEXTS: Record<string, { title: string; body: (d: Record<string, unknown>) => string }> = {
  'verification.approved': { title: 'Hujjatingiz tasdiqlandi', body: () => 'Hujjatingiz muvaffaqiyatli tekshirildi.' },
  'verification.rejected': {
    title: 'Hujjatingiz rad etildi',
    body: (d) => `Sabab: ${String(d.reason ?? '')}.${d.blocked ? ' Hisobingiz bloklandi, administratorlarga murojaat qiling.' : ' Hujjatni qayta yuborishingiz mumkin.'}`,
  },
};
export class PgUserNotifier implements UserNotifier {
  constructor(private readonly db: Db) {}
  async notify(userId: number, type: string, data: Record<string, unknown>) {
    const t = TEXTS[type] ?? { title: type, body: () => '' };
    await this.db.query(
      'INSERT INTO notifications (user_id, type, title, body, dedup_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dedup_key) DO NOTHING',
      [userId, type, t.title, t.body(data), `${type}:${userId}:${randomUUID()}`]);
  }
}
