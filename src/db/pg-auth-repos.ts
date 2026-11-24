import { Db, uniqueViolation } from './db';
import {
  CodeRecord, CodeRepo, DuplicateError, EmailOutbox, LoginThrottleRepo, NewUser, SessionRecord,
  SessionRepo, ThrottleState, UserRecord, UserRepo,
} from '../auth/ports';

interface UserRow {
  id: number; public_id: string; first_name: string; last_name: string; email: string; phone: string;
  password_hash: string; status: UserRecord['status']; email_verified_at: Date | null;
}
const toUser = (r: UserRow): UserRecord => ({
  id: r.id, publicId: r.public_id, firstName: r.first_name, lastName: r.last_name, email: r.email,
  phone: r.phone, passwordHash: r.password_hash, status: r.status, emailVerifiedAt: r.email_verified_at,
});

export class PgUserRepo implements UserRepo {
  constructor(private readonly db: Db) {}
  async findByEmail(email: string) {
    const r = await this.db.query<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }
  async findByPhone(phone: string) {
    const r = await this.db.query<UserRow>('SELECT * FROM users WHERE phone = $1', [phone]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }
  async findById(id: number) {
    const r = await this.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }
  async create(n: NewUser): Promise<UserRecord> {
    try {
      return await this.db.tx(async (c) => {
        const r = await c.query<UserRow>(
          `INSERT INTO users (public_id, first_name, last_name, email, phone, password_hash, birth_date,
                              tos_version, privacy_version, tos_accepted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [n.publicId, n.firstName, n.lastName, n.email, n.phone, n.passwordHash,
           n.birthDate.toISOString().slice(0, 10), n.tosVersion, n.privacyVersion, n.tosAcceptedAt]);
        await c.query('INSERT INTO user_verifications (user_id) VALUES ($1)', [r.rows[0].id]);
        return toUser(r.rows[0]);
      });
    } catch (e) {
      const k = uniqueViolation(e);
      if (k === 'users_email_key') throw new DuplicateError('email');
      if (k === 'users_phone_key') throw new DuplicateError('phone');
      if (k === 'users_public_id_key') throw new DuplicateError('publicId');
      throw e;
    }
  }
  async markEmailVerified(id: number, at: Date) {
    await this.db.query(
      `UPDATE users SET email_verified_at = $2, updated_at = now(),
              status = CASE WHEN status = 'PENDING_EMAIL' THEN 'PENDING_DOCUMENT' ELSE status END
       WHERE id = $1`, [id, at]);
  }
}

type CodeRow = { id: number; code_hash: string; expires_at: Date; attempts: number };
type SessionRow = { id: number; user_id: number; expires_at: Date; revoked_at: Date | null };

export class PgCodeRepo implements CodeRepo {
  constructor(private readonly db: Db) {}
  async replace(userId: number, channel: 'EMAIL' | 'PHONE', codeHash: string, expiresAt: Date): Promise<CodeRecord> {
    return this.db.tx(async (c) => {
      await c.query('UPDATE verification_codes SET consumed_at = now() WHERE user_id=$1 AND channel=$2 AND consumed_at IS NULL', [userId, channel]);
      const r = await c.query(
        'INSERT INTO verification_codes (user_id, channel, code_hash, expires_at) VALUES ($1,$2,$3,$4) RETURNING id, code_hash, expires_at, attempts',
        [userId, channel, codeHash, expiresAt]);
      return this.map(r.rows[0]);
    });
  }
  async findActive(userId: number, channel: 'EMAIL' | 'PHONE') {
    const r = await this.db.query<CodeRow>(
      `SELECT id, code_hash, expires_at, attempts FROM verification_codes
       WHERE user_id=$1 AND channel=$2 AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`, [userId, channel]);
    return r.rows[0] ? this.map(r.rows[0]) : null;
  }
  async incrementAttempts(id: number) { await this.db.query('UPDATE verification_codes SET attempts = attempts + 1 WHERE id=$1', [id]); }
  async consume(id: number, at: Date) { await this.db.query('UPDATE verification_codes SET consumed_at=$2 WHERE id=$1', [id, at]); }
  private map(r: { id: number; code_hash: string; expires_at: Date; attempts: number }): CodeRecord {
    return { id: r.id, codeHash: r.code_hash, expiresAt: r.expires_at, attempts: r.attempts };
  }
}

export class PgSessionRepo implements SessionRepo {
  constructor(private readonly db: Db) {}
  async create(s: { userId: number; tokenHash: string; expiresAt: Date; ip?: string; userAgent?: string }): Promise<SessionRecord> {
    const r = await this.db.query<SessionRow>(
      'INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5) RETURNING id, user_id, expires_at, revoked_at',
      [s.userId, s.tokenHash, s.expiresAt, s.ip ?? null, s.userAgent ?? null]);
    return this.map(r.rows[0]);
  }
  async findByTokenHash(h: string) {
    const r = await this.db.query<SessionRow>('SELECT id, user_id, expires_at, revoked_at FROM sessions WHERE token_hash=$1 AND user_id IS NOT NULL', [h]);
    return r.rows[0] ? this.map(r.rows[0]) : null;
  }
  async revoke(id: number, at: Date) { await this.db.query('UPDATE sessions SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL', [id, at]); }
  private map(r: { id: number; user_id: number; expires_at: Date; revoked_at: Date | null }): SessionRecord {
    return { id: r.id, userId: r.user_id, expiresAt: r.expires_at, revokedAt: r.revoked_at };
  }
}

export class PgThrottleRepo implements LoginThrottleRepo {
  constructor(private readonly db: Db) {}
  async get(key: string): Promise<ThrottleState | null> {
    const r = await this.db.query<{ failures: number; locked_until: Date | null }>('SELECT failures, locked_until FROM login_throttle WHERE key=$1', [key]);
    return r.rows[0] ? { failures: r.rows[0].failures, lockedUntil: r.rows[0].locked_until } : null;
  }
  async save(key: string, s: ThrottleState) {
    await this.db.query(
      `INSERT INTO login_throttle (key, failures, locked_until) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET failures=$2, locked_until=$3, updated_at=now()`, [key, s.failures, s.lockedUntil]);
  }
  async clear(key: string) { await this.db.query('DELETE FROM login_throttle WHERE key=$1', [key]); }
}


export class PgEmailOutbox implements EmailOutbox {
  constructor(private readonly db: Db) {}

  async enqueue(m: {
    userId: number;
    dedupKey: string;
    to: string;
    template: string;
    data: Record<string, unknown>;
    runAt: Date;
    expiresAt: Date;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO notification_outbox
        (channel, user_id, dedup_key, payload, run_at, expires_at)
       VALUES ('EMAIL', $1, $2, $3, $4, $5)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [
        m.userId,
        m.dedupKey,
        JSON.stringify({
          to: m.to,
          template: m.template,
          data: m.data,
        }),
        m.runAt,
        m.expiresAt,
      ],
    );
  }
}

