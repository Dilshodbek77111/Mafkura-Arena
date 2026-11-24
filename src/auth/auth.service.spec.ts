import { AuthError, AuthService, DEFAULT_AUTH_CONFIG, RegisterInput } from './auth.service';
import {
  CodeRecord, CodeRepo, DuplicateError, EmailOutbox, LoginThrottleRepo, NewUser, SessionRecord,
  SessionRepo, ThrottleState, UserRecord, UserRepo, UserStatus,
} from './ports';

class FakeUsers implements UserRepo {
  rows: UserRecord[] = []; seq = 1; publicIdCollisions = 0;
  async findByEmail(e: string) { return this.rows.find((u) => u.email === e) ?? null; }
  async findByPhone(p: string) { return this.rows.find((u) => u.phone === p) ?? null; }
  async findById(id: number) { return this.rows.find((u) => u.id === id) ?? null; }
  async create(n: NewUser) {
    if (this.publicIdCollisions > 0) { this.publicIdCollisions--; throw new DuplicateError('publicId'); }
    if (this.rows.some((u) => u.email === n.email)) throw new DuplicateError('email');
    if (this.rows.some((u) => u.phone === n.phone)) throw new DuplicateError('phone');
    const u: UserRecord = { id: this.seq++, publicId: n.publicId, firstName: n.firstName, lastName: n.lastName,
      email: n.email, phone: n.phone, passwordHash: n.passwordHash, status: 'PENDING_EMAIL', emailVerifiedAt: null };
    this.rows.push(u); return u;
  }
  async markEmailVerified(id: number, at: Date) {
    const u = this.rows.find((x) => x.id === id)!; u.emailVerifiedAt = at; u.status = 'PENDING_DOCUMENT';
  }
  setStatus(email: string, s: UserStatus) { this.rows.find((u) => u.email === email)!.status = s; }
}
class FakeCodes implements CodeRepo {
  rows: (CodeRecord & { userId: number; channel: string; consumed: boolean })[] = []; seq = 1;
  async replace(userId: number, channel: 'EMAIL' | 'PHONE', codeHash: string, expiresAt: Date) {
    this.rows.filter((r) => r.userId === userId && r.channel === channel).forEach((r) => (r.consumed = true));
    const r = { id: this.seq++, userId, channel, codeHash, expiresAt, attempts: 0, consumed: false };
    this.rows.push(r); return r;
  }
  async findActive(userId: number, channel: 'EMAIL' | 'PHONE') {
    return [...this.rows].reverse().find((r) => r.userId === userId && r.channel === channel && !r.consumed) ?? null;
  }
  async incrementAttempts(id: number) { this.rows.find((r) => r.id === id)!.attempts++; }
  async consume(id: number) { this.rows.find((r) => r.id === id)!.consumed = true; }
}
class FakeSessions implements SessionRepo {
  rows: (SessionRecord & { tokenHash: string })[] = []; seq = 1;
  async create(s: { userId: number; tokenHash: string; expiresAt: Date }) {
    const r = { id: this.seq++, userId: s.userId, tokenHash: s.tokenHash, expiresAt: s.expiresAt, revokedAt: null as Date | null };
    this.rows.push(r); return r;
  }
  async findByTokenHash(h: string) { return this.rows.find((r) => r.tokenHash === h) ?? null; }
  async revoke(id: number, at: Date) { this.rows.find((r) => r.id === id)!.revokedAt = at; }
}
class FakeThrottle implements LoginThrottleRepo {
  m = new Map<string, ThrottleState>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async save(k: string, s: ThrottleState) { this.m.set(k, s); }
  async clear(k: string) { this.m.delete(k); }
}
class FakeOutbox implements EmailOutbox {
  sent: { dedupKey: string; to: string; data: Record<string, unknown> }[] = [];
  async enqueue(m: Parameters<EmailOutbox['enqueue']>[0]) {
    if (this.sent.some((x) => x.dedupKey === m.dedupKey)) return; // dedupKey unique
    this.sent.push(m);
  }
  lastCode() { return this.sent[this.sent.length - 1].data.code as string; }
}

const base: RegisterInput = {
  firstName: 'Jasur', lastName: 'Karimov', email: 'Jasur@Example.com', phone: '+998 90 123 45 67',
  password: 'secret-pass-1', birthDate: '2000-05-10', acceptTos: true, acceptPrivacy: true,
};

function setup() {
  let now = new Date('2026-11-22T10:00:00Z');
  const users = new FakeUsers(), codes = new FakeCodes(), sessions = new FakeSessions(),
    throttle = new FakeThrottle(), outbox = new FakeOutbox();
  const svc = new AuthService({
    users, codes, sessions, throttle, outbox, now: () => now,
    config: { ...DEFAULT_AUTH_CONFIG, codeSecret: 'test-secret', tosVersion: 'tos-1', privacyVersion: 'pp-1',
      adminTelegramLinks: ['https://t.me/admin1'] },
  });
  return { svc, users, codes, sessions, throttle, outbox, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}
const code = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return 'OK'; } catch (e) { return e instanceof AuthError ? e.code : `ERR:${e}`; }
};
const verified = async (s: ReturnType<typeof setup>) => {
  await s.svc.register(base); await s.svc.verifyEmail(base.email, s.outbox.lastCode());
};

describe('ro\'yxatdan o\'tish', () => {
  it('foydalanuvchi yaratiladi, parol Argon2id, email kodi outboxga tushadi', async () => {
    const s = setup();
    await s.svc.register(base);
    expect(s.users.rows[0]).toMatchObject({ email: 'jasur@example.com', phone: '+998901234567', status: 'PENDING_EMAIL' });
    expect(s.users.rows[0].passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(s.outbox.sent).toHaveLength(1);
    expect(s.outbox.lastCode()).toMatch(/^\d{6}$/);
  });
  it('16 yoshdan kichik rad etiladi, aynan 16 yosh qabul qilinadi', async () => {
    const s = setup();
    const e = await s.svc.register({ ...base, birthDate: '2010-11-23' }).catch((x) => x);
    expect(e.details.fields.birthDate).toBe('UNDER_MIN_AGE');
    await expect(s.svc.register({ ...base, birthDate: '2010-11-22' })).resolves.toBeDefined();
  });
  it('takroriy email va telefon (turli yozilishda ham)', async () => {
    const s = setup();
    await s.svc.register(base);
    expect(await code(s.svc.register({ ...base, email: 'JASUR@example.com', phone: '+998909999999' }))).toBe('EMAIL_TAKEN');
    expect(await code(s.svc.register({ ...base, email: 'other@example.com', phone: '901234567' }))).toBe('PHONE_TAKEN');
  });
  it('shartlar qabul qilinmasa rad etiladi', async () => {
    const s = setup();
    expect(await code(s.svc.register({ ...base, acceptTos: false }))).toBe('VALIDATION');
    expect(await code(s.svc.register({ ...base, acceptPrivacy: false }))).toBe('VALIDATION');
  });
  it('publicId to\'qnashuvida qayta urinadi', async () => {
    const s = setup(); s.users.publicIdCollisions = 2;
    await expect(s.svc.register(base)).resolves.toBeDefined();
    expect(s.users.rows).toHaveLength(1);
  });
});

describe('email tasdiqlash', () => {
  it('to\'g\'ri kod: PENDING_DOCUMENT, takroriy chaqiruv idempotent', async () => {
    const s = setup(); await s.svc.register(base);
    await s.svc.verifyEmail(base.email, s.outbox.lastCode());
    expect(s.users.rows[0].status).toBe('PENDING_DOCUMENT');
    expect(await code(s.svc.verifyEmail(base.email, '000000'))).toBe('OK');
  });
  it('noto\'g\'ri kod; 5 urinishdan keyin to\'g\'ri kod ham o\'tmaydi', async () => {
    const s = setup(); await s.svc.register(base);
    const good = s.outbox.lastCode(); const bad = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect(await code(s.svc.verifyEmail(base.email, bad))).toBe('INVALID_CODE');
    expect(await code(s.svc.verifyEmail(base.email, good))).toBe('TOO_MANY_ATTEMPTS');
  });
  it('muddati o\'tgan kod; qayta yuborilgan kod eskisini bekor qiladi', async () => {
    const s = setup(); await s.svc.register(base);
    const old = s.outbox.lastCode();
    s.advance(16 * 60 * 1000);
    expect(await code(s.svc.verifyEmail(base.email, old))).toBe('CODE_EXPIRED');
    await s.svc.sendEmailCode(s.users.rows[0]);
    expect(s.outbox.sent).toHaveLength(2);
    await s.svc.verifyEmail(base.email, s.outbox.lastCode());
    expect(s.users.rows[0].status).toBe('PENDING_DOCUMENT');
  });
  it('mavjud bo\'lmagan email — umumiy INVALID_CODE', async () => {
    expect(await code(setup().svc.verifyEmail('no@one.uz', '123456'))).toBe('INVALID_CODE');
  });
});

describe('login', () => {
  it('email tasdiqlanmagan: faqat to\'g\'ri paroldan keyin EMAIL_NOT_VERIFIED', async () => {
    const s = setup(); await s.svc.register(base);
    expect(await code(s.svc.login(base.email, 'wrong-password'))).toBe('INVALID_CREDENTIALS');
    expect(await code(s.svc.login(base.email, base.password))).toBe('EMAIL_NOT_VERIFIED');
  });
  it('noto\'g\'ri parol va mavjud bo\'lmagan foydalanuvchi bir xil xato', async () => {
    const s = setup(); await verified(s);
    expect(await code(s.svc.login(base.email, 'nope-nope-1'))).toBe('INVALID_CREDENTIALS');
    expect(await code(s.svc.login('ghost@x.uz', 'nope-nope-1'))).toBe('INVALID_CREDENTIALS');
  });
  it('5 xato → bloklash (to\'g\'ri parol ham o\'tmaydi), 15 daqiqadan keyin ochiladi', async () => {
    const s = setup(); await verified(s);
    for (let i = 0; i < 5; i++) await code(s.svc.login(base.email, 'bad-bad-bad'));
    expect(await code(s.svc.login(base.email, base.password))).toBe('TOO_MANY_ATTEMPTS');
    s.advance(15 * 60 * 1000 + 1000);
    expect(await code(s.svc.login(base.email, base.password))).toBe('OK');
  });
  it('holatga qarab kirish darajasi', async () => {
    const s = setup(); await verified(s);
    expect((await s.svc.login(base.email, base.password)).access).toBe('VERIFICATION_ONLY'); // PENDING_DOCUMENT
    s.users.setStatus('jasur@example.com', 'DOC_REJECTED');
    expect((await s.svc.login(base.email, base.password)).access).toBe('VERIFICATION_ONLY');
    s.users.setStatus('jasur@example.com', 'ACTIVE');
    expect((await s.svc.login(base.email, base.password)).access).toBe('FULL');
  });
  it('bloklangan: Telegram havolalari qaytariladi', async () => {
    const s = setup(); await verified(s); s.users.setStatus('jasur@example.com', 'BLOCKED');
    const e = await s.svc.login(base.email, base.password).catch((x) => x);
    expect(e.code).toBe('ACCOUNT_BLOCKED');
    expect(e.details.adminTelegramLinks).toEqual(['https://t.me/admin1']);
  });
  it('sessiya: authenticate, logout, muddat tugashi', async () => {
    const s = setup(); await verified(s); s.users.setStatus('jasur@example.com', 'ACTIVE');
    const { token } = await s.svc.login(base.email, base.password);
    expect((await s.svc.authenticate(token)).access).toBe('FULL');
    expect(s.sessions.rows[0].tokenHash).not.toBe(token); // xom token saqlanmaydi
    await s.svc.logout(token);
    expect(await code(s.svc.authenticate(token))).toBe('UNAUTHENTICATED');
    const t2 = (await s.svc.login(base.email, base.password)).token;
    s.advance(8 * 24 * 3600 * 1000);
    expect(await code(s.svc.authenticate(t2))).toBe('UNAUTHENTICATED');
    expect(await code(s.svc.authenticate('garbage'))).toBe('UNAUTHENTICATED');
  });
});
