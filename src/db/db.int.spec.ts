/**
 * Haqiqiy PostgreSQL bilan integratsiya testlari.
 * Ishga tushirish: TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/mafkura_test npx jest db.int
 * DIQQAT: test bazasidagi hamma narsa o'chiriladi (nomida "test" bo'lishi shart).
 */
import { AuthError, AuthService, DEFAULT_AUTH_CONFIG } from '../auth/auth.service';
import { createDb, Db } from './db';
import { migrate } from './migrate';
import { PgCodeRepo, PgEmailOutbox, PgSessionRepo, PgThrottleRepo, PgUserRepo } from './pg-auth-repos';
import { PgAuditWriter, PgUserNotifier, PgVerificationRepo } from './pg-verification-repo';
import { DEFAULT_VERIFICATION_CONFIG, VerificationError, VerificationService } from '../verification/verification.service';
import { DocStorage } from '../verification/ports';

const URL = process.env.TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const input = (n: number) => ({
  firstName: 'Jasur', lastName: 'Karimov', email: `u${n}@example.com`, phone: `+99890${String(1000000 + n)}`,
  password: 'secret-pass-1', birthDate: '2000-05-10', acceptTos: true, acceptPrivacy: true,
});
class MemStorage implements DocStorage {
  files = new Map<string, Uint8Array>();
  async put(k: string, d: Uint8Array) { this.files.set(k, d); }
  async signedUrl(k: string, ttl: number) { return `https://s.test/${k}?ttl=${ttl}`; }
  async delete(k: string) { this.files.delete(k); }
}
const code = async (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e instanceof AuthError || e instanceof VerificationError ? e.code : `ERR:${(e as Error).message}`));

suite('PostgreSQL integratsiya', () => {
  let db: Db; let auth: AuthService; let ver: VerificationService; let storage: MemStorage;
  const makeAuth = () => new AuthService({
    users: new PgUserRepo(db), codes: new PgCodeRepo(db), sessions: new PgSessionRepo(db), throttle: new PgThrottleRepo(db),
    outbox: new PgEmailOutbox(db), now: () => new Date(),
    config: { ...DEFAULT_AUTH_CONFIG, codeSecret: 'it-secret', tosVersion: 'tos-1', privacyVersion: 'pp-1', adminTelegramLinks: ['https://t.me/a'] },
  });
  const insertAdmin = async (role: 'HEAD_ADMIN' | 'ADMIN', n: number) => {
    const r = await db.query("INSERT INTO admins (email, password_hash, first_name, last_name, role_id) VALUES ($1,'x','A','B',(SELECT id FROM roles WHERE key=$2)) RETURNING id", [`admin${n}@x.uz`, role]);
    return { id: r.rows[0].id as number, role };
  };
  const lastCode = async (email: string) => {
    const r = await db.query("SELECT payload FROM notification_outbox WHERE payload->>'to' = $1 ORDER BY id DESC LIMIT 1", [email]);
    return r.rows[0].payload.data.code as string;
  };
  const verifiedUser = async (n: number) => {
    const { userId } = await auth.register(input(n));
    await auth.verifyEmail(input(n).email, await lastCode(input(n).email));
    return userId;
  };

  beforeAll(async () => {
    if (!/test/.test(URL!)) throw new Error('TEST_DATABASE_URL nomida "test" bo\'lishi shart');
    db = createDb(URL!);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
  });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await migrate(db); // append-only jadvallar TRUNCATE ni rad etadi, shuning uchun sxema qayta yaratiladi
    storage = new MemStorage();
    auth = makeAuth();
    ver = new VerificationService({
      repo: new PgVerificationRepo(db), storage, audit: new PgAuditWriter(db), notifier: new PgUserNotifier(db),
      config: DEFAULT_VERIFICATION_CONFIG, now: () => new Date(),
    });
  });

  it('migratsiya qayta ishga tushirilsa hech narsa qo\'llanmaydi', async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it('ro\'yxatdan o\'tish → email tasdiqlash → login → authenticate → logout', async () => {
    const { userId } = await auth.register(input(1));
    const u = (await db.query('SELECT * FROM users WHERE id=$1', [userId])).rows[0];
    expect(u.status).toBe('PENDING_EMAIL');
    expect(u.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(await code(auth.login(input(1).email, input(1).password))).toBe('EMAIL_NOT_VERIFIED');
    await auth.verifyEmail(input(1).email, await lastCode(input(1).email));
    const { token, access } = await auth.login(input(1).email, input(1).password);
    expect(access).toBe('VERIFICATION_ONLY');
    expect((await db.query('SELECT 1 FROM sessions WHERE token_hash=$1', [token])).rowCount).toBe(0); // xom token saqlanmaydi
    expect((await auth.authenticate(token)).user.id).toBe(userId);
    await auth.logout(token);
    expect(await code(auth.authenticate(token))).toBe('UNAUTHENTICATED');
  });

  it('bir vaqtda 5 ta bir xil email bilan ro\'yxatdan o\'tish: faqat bittasi o\'tadi', async () => {
    const res = await Promise.all(Array.from({ length: 5 }, () => code(makeAuth().register(input(2)))));
    expect(res.filter((r) => r === 'OK')).toHaveLength(1);
    expect(res.filter((r) => r === 'EMAIL_TAKEN' || r === 'PHONE_TAKEN')).toHaveLength(4);
    expect((await db.query('SELECT count(*)::int n FROM users')).rows[0].n).toBe(1);
  });

  it('login bloklanishi bazada saqlanadi (boshqa servis nusxasida ham amal qiladi)', async () => {
    await verifiedUser(3);
    for (let i = 0; i < 5; i++) await code(auth.login(input(3).email, 'wrong-pass-1'));
    expect(await code(makeAuth().login(input(3).email, input(3).password))).toBe('TOO_MANY_ATTEMPTS');
  });

  it('outbox dedup_key takroriy yuborishni to\'sadi', async () => {
    const ob = new PgEmailOutbox(db); const m = { dedupKey: 'k1', to: 'a@b.uz', template: 't', data: {}, runAt: new Date(), expiresAt: new Date() };
    await ob.enqueue(m); await ob.enqueue(m);
    expect((await db.query("SELECT count(*)::int n FROM notification_outbox WHERE dedup_key='k1'")).rows[0].n).toBe(1);
  });

  it('hujjat: parallel ikki yuborish → bittasi PENDING_EXISTS, bazada 1 ta PENDING', async () => {
    const uid = await verifiedUser(4);
    const res = await Promise.all([ver.submit(uid, { data: JPEG }), ver.submit(uid, { data: JPEG })].map(code));
    expect(res.sort()).toEqual(['OK', 'PENDING_EXISTS']);
    expect((await db.query("SELECT count(*)::int n FROM verification_attempts WHERE status='PENDING'")).rows[0].n).toBe(1);
  });

  it('ikki admin bir vaqtda qaror chiqaradi: faqat bittasi yutadi, holat izchil', async () => {
    const uid = await verifiedUser(5);
    const a1 = await insertAdmin('ADMIN', 1), a2 = await insertAdmin('ADMIN', 2);
    const { attemptId } = await ver.submit(uid, { data: JPEG });
    const res = await Promise.all([
      code(ver.review(a1, attemptId, { approve: true })),
      code(ver.review(a2, attemptId, { approve: false, reason: 'Xira' })),
    ]);
    expect(res.sort()).toEqual(['ALREADY_DECIDED', 'OK']);
    const st = (await db.query('SELECT u.status, v.doc_status FROM users u JOIN user_verifications v ON v.user_id=u.id WHERE u.id=$1', [uid])).rows[0];
    expect(['ACTIVE', 'DOC_REJECTED']).toContain(st.status);
    expect((await db.query("SELECT count(*)::int n FROM admin_audit_log WHERE action LIKE 'verification.%'")).rows[0].n).toBe(1);
  });

  it('tasdiqlash: SMS keyinga qoldirilgani uchun telefonsiz ham ACTIVE (v2 o\'zgartirilgan qaror)', async () => {
    const uid = await verifiedUser(6); const admin = await insertAdmin('ADMIN', 3);
    const { attemptId } = await ver.submit(uid, { data: JPEG });
    expect((await ver.review(admin, attemptId, { approve: true })).newUserStatus).toBe('ACTIVE');
    expect((await auth.login(input(6).email, input(6).password)).access).toBe('FULL');
  });

  it('4 ta rad etish → BLOCKED; admin imkoniyat beradi; hujjatni ko\'rish va o\'chirish audit qilinadi', async () => {
    const uid = await verifiedUser(7); const admin = await insertAdmin('ADMIN', 4);
    for (let i = 1; i <= 4; i++) {
      const r = await ver.submit(uid, { data: JPEG });
      await ver.review(admin, r.attemptId, { approve: false, reason: `sabab ${i}` });
    }
    expect((await db.query('SELECT status FROM users WHERE id=$1', [uid])).rows[0].status).toBe('BLOCKED');
    expect((await code(auth.login(input(7).email, input(7).password)))).toBe('ACCOUNT_BLOCKED');
    expect(await code(ver.submit(uid, { data: JPEG }))).toBe('NOT_ALLOWED_STATE');
    await ver.grantExtraAttempt(admin, uid, 'Telegram orqali murojaat');
    expect((await db.query('SELECT status FROM users WHERE id=$1', [uid])).rows[0].status).toBe('DOC_REJECTED');
    const r5 = await ver.submit(uid, { data: JPEG });
    expect(r5.attemptNo).toBe(5);
    expect(await ver.viewDocument(admin, 5)).toContain('ttl=60');
    expect((await db.query("SELECT count(*)::int n FROM admin_audit_log WHERE action='document.view'")).rows[0].n).toBe(1);
    expect((await db.query("SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND type='verification.rejected'", [uid])).rows[0].n).toBe(4);
  });

  it('saqlash muddati o\'tgan hujjatlar o\'chiriladi (purge yoqilganda)', async () => {
    const uid = await verifiedUser(8); const admin = await insertAdmin('ADMIN', 5);
    const { attemptId } = await ver.submit(uid, { data: JPEG });
    await ver.review(admin, attemptId, { approve: false, reason: 'x' });
    const future = new Date(Date.now() + 31 * 24 * 3600 * 1000);
    const purger = new VerificationService({
      repo: new PgVerificationRepo(db), storage, audit: new PgAuditWriter(db), notifier: new PgUserNotifier(db),
      config: { ...DEFAULT_VERIFICATION_CONFIG, autoPurgeEnabled: true }, now: () => future,
    });
    expect(await purger.purgeExpired()).toBe(1);
    expect(storage.files.size).toBe(0);
    expect((await db.query('SELECT deleted_at FROM verification_documents')).rows[0].deleted_at).not.toBeNull();
    expect(await purger.purgeExpired()).toBe(0);
  });

  it('audit log append-only: UPDATE, DELETE, TRUNCATE rad etiladi', async () => {
    await new PgAuditWriter(db).write({ adminId: null, action: 'test', objectType: 'T', objectId: '1' });
    await expect(db.query("UPDATE admin_audit_log SET action='x'")).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM admin_audit_log')).rejects.toThrow(/append-only/);
    await expect(db.query('TRUNCATE admin_audit_log')).rejects.toThrow(/append-only/);
    expect((await db.query('SELECT count(*)::int n FROM admin_audit_log')).rows[0].n).toBeGreaterThan(0);
  });
});
