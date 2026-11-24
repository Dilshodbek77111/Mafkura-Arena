import { Db } from './db';
import { AdminRecord, AdminRepo, AdminSessionRecord, AdminSessionRepo } from '../auth/admin-auth.service';

type AdminRow = { id: number; email: string; password_hash: string; first_name: string; last_name: string; role: AdminRecord['role']; active: boolean };
const toAdmin = (r: AdminRow): AdminRecord => ({ id: r.id, email: r.email, passwordHash: r.password_hash, firstName: r.first_name, lastName: r.last_name, role: r.role, active: r.active });
const SEL = 'SELECT a.id, a.email, a.password_hash, a.first_name, a.last_name, a.active, r.key AS role FROM admins a JOIN roles r ON r.id = a.role_id';

export class PgAdminRepo implements AdminRepo {
  constructor(private readonly db: Db) {}
  async findByEmail(email: string) { const r = await this.db.query<AdminRow>(`${SEL} WHERE a.email = $1`, [email]); return r.rows[0] ? toAdmin(r.rows[0]) : null; }
  async findById(id: number) { const r = await this.db.query<AdminRow>(`${SEL} WHERE a.id = $1`, [id]); return r.rows[0] ? toAdmin(r.rows[0]) : null; }
}

type SRow = { id: number; admin_id: number; expires_at: Date; revoked_at: Date | null };
const toS = (r: SRow): AdminSessionRecord => ({ id: r.id, adminId: r.admin_id, expiresAt: r.expires_at, revokedAt: r.revoked_at });
export class PgAdminSessionRepo implements AdminSessionRepo {
  constructor(private readonly db: Db) {}
  async create(s: { adminId: number; tokenHash: string; expiresAt: Date; ip?: string; userAgent?: string }) {
    const r = await this.db.query<SRow>('INSERT INTO sessions (admin_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5) RETURNING id, admin_id, expires_at, revoked_at',
      [s.adminId, s.tokenHash, s.expiresAt, s.ip ?? null, s.userAgent ?? null]);
    return toS(r.rows[0]);
  }
  async findByTokenHash(h: string) { const r = await this.db.query<SRow>('SELECT id, admin_id, expires_at, revoked_at FROM sessions WHERE token_hash=$1 AND admin_id IS NOT NULL', [h]); return r.rows[0] ? toS(r.rows[0]) : null; }
  async revoke(id: number, at: Date) { await this.db.query('UPDATE sessions SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL', [id, at]); }
}
