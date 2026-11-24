
import {
  ageInYears, isValidEmail, isValidName, MIN_AGE, normalizeEmail, normalizeUzPhone,
  parseBirthDate, validateUserPassword,
} from './validation';
import {
  codeMatches, generateCode, generatePublicId, generateSessionToken, hashCode, hashPassword,
  hashToken, verifyPassword,
} from './crypto';
import {
  CodeRepo, DuplicateError, EmailOutbox, LoginThrottleRepo, SessionRepo, UserRecord, UserRepo,
} from './ports';

export type AuthErrorCode =
  | 'VALIDATION' | 'EMAIL_TAKEN' | 'PHONE_TAKEN' | 'INVALID_CREDENTIALS' | 'TOO_MANY_ATTEMPTS'
  | 'EMAIL_NOT_VERIFIED' | 'ACCOUNT_BLOCKED' | 'INVALID_CODE' | 'CODE_EXPIRED' | 'UNAUTHENTICATED';

export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode, public readonly details?: Record<string, unknown>) {
    super(code);
  }
}

export type AccessLevel = 'FULL' | 'VERIFICATION_ONLY';

export interface AuthConfig {
  codeSecret: string;
  sessionTtlMs: number;
  codeTtlMs: number;
  maxCodeAttempts: number;
  maxLoginFailures: number;
  loginLockMs: number;
  tosVersion: string;
  privacyVersion: string;
  adminTelegramLinks: string[];
}

export const DEFAULT_AUTH_CONFIG: Omit<AuthConfig, 'codeSecret' | 'tosVersion' | 'privacyVersion' | 'adminTelegramLinks'> = {
  sessionTtlMs: 7 * 24 * 3600 * 1000,
  codeTtlMs: 15 * 60 * 1000,
  maxCodeAttempts: 5,
  maxLoginFailures: 5,
  loginLockMs: 15 * 60 * 1000,
};

export interface RegisterInput {
  firstName: string; lastName: string; email: string; phone: string; password: string;
  birthDate: string; acceptTos: boolean; acceptPrivacy: boolean;
}

export interface Deps {
  users: UserRepo; codes: CodeRepo; sessions: SessionRepo; throttle: LoginThrottleRepo;
  outbox: EmailOutbox; config: AuthConfig; now: () => Date;
}

/** Hech qachon mavjud bo'lmagan foydalanuvchi uchun ham xesh tekshiriladi (vaqt bo'yicha farq bo'lmasligi uchun). */
let dummyHash: Promise<string> | null = null;
export const getDummyHash = () => (dummyHash ??= hashPassword('dummy-password-for-timing'));

export class AuthService {
  constructor(private readonly d: Deps) {}

  async register(input: RegisterInput): Promise<{ userId: number }> {
    const now = this.d.now();
    const errors: Record<string, string> = {};

    if (!isValidName(input.firstName)) errors.firstName = 'INVALID_NAME';
    if (!isValidName(input.lastName)) errors.lastName = 'INVALID_NAME';
    const email = normalizeEmail(input.email);
    if (!isValidEmail(email)) errors.email = 'INVALID_EMAIL';
    const phone = normalizeUzPhone(input.phone);
    if (!phone) errors.phone = 'INVALID_PHONE';
    const pwErr = validateUserPassword(input.password);
    if (pwErr) errors.password = pwErr;
    const birth = parseBirthDate(input.birthDate);
    if (!birth) errors.birthDate = 'INVALID_DATE';
    else if (birth.getTime() > now.getTime() || ageInYears(birth, now) > 120) errors.birthDate = 'INVALID_DATE';
    else if (ageInYears(birth, now) < MIN_AGE) errors.birthDate = 'UNDER_MIN_AGE';
    if (input.acceptTos !== true) errors.acceptTos = 'REQUIRED';
    if (input.acceptPrivacy !== true) errors.acceptPrivacy = 'REQUIRED';
    if (Object.keys(errors).length) throw new AuthError('VALIDATION', { fields: errors });

    if (await this.d.users.findByEmail(email)) throw new AuthError('EMAIL_TAKEN');
    if (await this.d.users.findByPhone(phone!)) throw new AuthError('PHONE_TAKEN');

    const passwordHash = await hashPassword(input.password);
    let user: UserRecord | null = null;
    for (let i = 0; i < 5 && !user; i++) {
      try {
        user = await this.d.users.create({
          publicId: generatePublicId(), firstName: input.firstName.trim(), lastName: input.lastName.trim(),
          email, phone: phone!, passwordHash, birthDate: birth!,
          tosVersion: this.d.config.tosVersion, privacyVersion: this.d.config.privacyVersion, tosAcceptedAt: now,
        });
      } catch (e) {
        if (!(e instanceof DuplicateError)) throw e;
        if (e.field === 'email') throw new AuthError('EMAIL_TAKEN');
        if (e.field === 'phone') throw new AuthError('PHONE_TAKEN');
      }
    }
    if (!user) throw new Error('could not allocate publicId');

    await this.sendEmailCode(user);
    return { userId: user.id };
  }

  /** Yangi email kodi yuboradi (eskisi bekor qilinadi). */
  async sendEmailCode(user: Pick<UserRecord, 'id' | 'email'>): Promise<void> {
    const now = this.d.now();
    const code = generateCode();
    const expiresAt = new Date(now.getTime() + this.d.config.codeTtlMs);
    const rec = await this.d.codes.replace(user.id, 'EMAIL', hashCode(code, this.d.config.codeSecret), expiresAt);

    await this.d.outbox.enqueue({
      userId: user.id,
      dedupKey: `verify-email:${user.id}:${rec.id}`,
      to: user.email,
      template: 'verify-email',
      data: { code },
      runAt: now,
      expiresAt,
    });
  }

  /** Faqat tasdiqlanmagan hisobga yangi kod yuboriladi. */
  async resendEmailCode(emailRaw: string): Promise<void> {
    const user = await this.d.users.findByEmail(normalizeEmail(emailRaw));
    if (user && !user.emailVerifiedAt && user.status === 'PENDING_EMAIL') await this.sendEmailCode(user);
  }

  async verifyEmail(emailRaw: string, code: string): Promise<void> {
    const now = this.d.now();
    const user = await this.d.users.findByEmail(normalizeEmail(emailRaw));
    if (!user) throw new AuthError('INVALID_CODE');
    if (user.emailVerifiedAt) return;
    const rec = await this.d.codes.findActive(user.id, 'EMAIL');
    if (!rec) throw new AuthError('INVALID_CODE');
    if (rec.expiresAt.getTime() <= now.getTime()) throw new AuthError('CODE_EXPIRED');
    if (rec.attempts >= this.d.config.maxCodeAttempts) throw new AuthError('TOO_MANY_ATTEMPTS');
    if (!codeMatches(code.trim(), rec.codeHash, this.d.config.codeSecret)) {
      await this.d.codes.incrementAttempts(rec.id);
      throw new AuthError('INVALID_CODE');
    }
    await this.d.codes.consume(rec.id, now);
    await this.d.users.markEmailVerified(user.id, now);
  }

  async login(emailRaw: string, password: string, ctx: { ip?: string; userAgent?: string } = {}) {
    const now = this.d.now();
    const email = normalizeEmail(emailRaw);
    const keys = [`login:email:${email}`, ...(ctx.ip ? [`login:ip:${ctx.ip}`] : [])];

    for (const k of keys) {
      const st = await this.d.throttle.get(k);
      if (st?.lockedUntil && st.lockedUntil.getTime() > now.getTime()) {
        throw new AuthError('TOO_MANY_ATTEMPTS', { retryAfterSec: Math.ceil((st.lockedUntil.getTime() - now.getTime()) / 1000) });
      }
    }

    const user = await this.d.users.findByEmail(email);
    const ok = await verifyPassword(user ? user.passwordHash : await getDummyHash(), password);
    if (!user || !ok) {
      for (const k of keys) {
        const st = (await this.d.throttle.get(k)) ?? { failures: 0, lockedUntil: null };
        const failures = st.failures + 1;
        const lock = failures >= this.d.config.maxLoginFailures;
        await this.d.throttle.save(k, {
          failures: lock ? 0 : failures,
          lockedUntil: lock ? new Date(now.getTime() + this.d.config.loginLockMs) : null,
        });
      }
      throw new AuthError('INVALID_CREDENTIALS');
    }
    for (const k of keys) await this.d.throttle.clear(k);

    if (user.status === 'DELETED') throw new AuthError('INVALID_CREDENTIALS');
    if (user.status === 'BLOCKED') throw new AuthError('ACCOUNT_BLOCKED', { adminTelegramLinks: this.d.config.adminTelegramLinks });
    if (user.status === 'PENDING_EMAIL') throw new AuthError('EMAIL_NOT_VERIFIED');

    const token = generateSessionToken();
    const expiresAt = new Date(now.getTime() + this.d.config.sessionTtlMs);
    await this.d.sessions.create({ userId: user.id, tokenHash: hashToken(token), expiresAt, ip: ctx.ip, userAgent: ctx.userAgent });
    return { token, expiresAt, access: accessLevel(user.status), userId: user.id };
  }

  async authenticate(token: string): Promise<{ user: UserRecord; access: AccessLevel }> {
    const now = this.d.now();
    const s = await this.d.sessions.findByTokenHash(hashToken(token));
    if (!s || s.revokedAt || s.expiresAt.getTime() <= now.getTime()) throw new AuthError('UNAUTHENTICATED');
    const user = await this.d.users.findById(s.userId);
    if (!user || user.status === 'DELETED') throw new AuthError('UNAUTHENTICATED');
    if (user.status === 'BLOCKED') throw new AuthError('ACCOUNT_BLOCKED', { adminTelegramLinks: this.d.config.adminTelegramLinks });
    return { user, access: accessLevel(user.status) };
  }

  async logout(token: string): Promise<void> {
    const s = await this.d.sessions.findByTokenHash(hashToken(token));
    if (s && !s.revokedAt) await this.d.sessions.revoke(s.id, this.d.now());
  }
}

/** Hujjat tasdiqlanmaguncha / rad etilganda faqat verification sahifalariga ruxsat. */
export function accessLevel(status: UserRecord['status']): AccessLevel {
  return status === 'ACTIVE' || status === 'DELETION_PENDING' ? 'FULL' : 'VERIFICATION_ONLY';
}
