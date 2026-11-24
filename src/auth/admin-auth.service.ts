import { generateSessionToken, hashToken, verifyPassword } from './crypto';
import { AuthError, getDummyHash } from './auth.service';
import { LoginThrottleRepo } from './ports';
import { normalizeEmail } from './validation';
import { AdminRole } from '../rbac/rbac';

export interface AdminRecord { id: number; email: string; passwordHash: string; firstName: string; lastName: string; role: AdminRole; active: boolean }
export interface AdminRepo { findByEmail(email: string): Promise<AdminRecord | null>; findById(id: number): Promise<AdminRecord | null> }
export interface AdminSessionRecord { id: number; adminId: number; expiresAt: Date; revokedAt: Date | null }
export interface AdminSessionRepo {
  create(s: { adminId: number; tokenHash: string; expiresAt: Date; ip?: string; userAgent?: string }): Promise<AdminSessionRecord>;
  findByTokenHash(h: string): Promise<AdminSessionRecord | null>;
  revoke(id: number, at: Date): Promise<void>;
}
export interface AdminPrincipal { id: number; role: AdminRole; email: string; name: string }

export class AdminAuthService {
  constructor(private readonly d: { admins: AdminRepo; sessions: AdminSessionRepo; throttle: LoginThrottleRepo; now: () => Date;
    sessionTtlMs?: number; maxFailures?: number; lockMs?: number }) {}
  private get ttl() { return this.d.sessionTtlMs ?? 8 * 3600 * 1000; }

  async login(emailRaw: string, password: string, ctx: { ip?: string; userAgent?: string } = {}) {
    const now = this.d.now(); const email = normalizeEmail(emailRaw);
    const max = this.d.maxFailures ?? 5, lockMs = this.d.lockMs ?? 15 * 60 * 1000;
    const keys = [`admin-login:email:${email}`, ...(ctx.ip ? [`admin-login:ip:${ctx.ip}`] : [])];
    for (const k of keys) {
      const st = await this.d.throttle.get(k);
      if (st?.lockedUntil && st.lockedUntil > now) throw new AuthError('TOO_MANY_ATTEMPTS', { retryAfterSec: Math.ceil((st.lockedUntil.getTime() - now.getTime()) / 1000) });
    }
    const admin = await this.d.admins.findByEmail(email);
    const ok = await verifyPassword(admin ? admin.passwordHash : await getDummyHash(), password);
    if (!admin || !ok || !admin.active) {
      for (const k of keys) {
        const st = (await this.d.throttle.get(k)) ?? { failures: 0, lockedUntil: null };
        const f = st.failures + 1; const lock = f >= max;
        await this.d.throttle.save(k, { failures: lock ? 0 : f, lockedUntil: lock ? new Date(now.getTime() + lockMs) : null });
      }
      throw new AuthError('INVALID_CREDENTIALS');
    }
    for (const k of keys) await this.d.throttle.clear(k);
    const token = generateSessionToken(); const expiresAt = new Date(now.getTime() + this.ttl);
    await this.d.sessions.create({ adminId: admin.id, tokenHash: hashToken(token), expiresAt, ip: ctx.ip, userAgent: ctx.userAgent });
    return { token, expiresAt };
  }

  async authenticate(token: string): Promise<AdminPrincipal> {
    const s = await this.d.sessions.findByTokenHash(hashToken(token));
    if (!s || s.revokedAt || s.expiresAt <= this.d.now()) throw new AuthError('UNAUTHENTICATED');
    const a = await this.d.admins.findById(s.adminId);
    if (!a || !a.active) throw new AuthError('UNAUTHENTICATED');
    return { id: a.id, role: a.role, email: a.email, name: `${a.firstName} ${a.lastName}` };
  }

  async logout(token: string): Promise<void> {
    const s = await this.d.sessions.findByTokenHash(hashToken(token));
    if (s && !s.revokedAt) await this.d.sessions.revoke(s.id, this.d.now());
  }
}
