/**
 * HTTP e2e (supertest) — haqiqiy NestJS ilova + haqiqiy PostgreSQL + haqiqiy fayl saqlash.
 * Ishga tushirish: TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/mafkura_test npx jest app.e2e
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { AppModule } from './app.module';
import { hashPassword } from './auth/crypto';
import { configureApp } from './bootstrap';
import { AppConfig, loadConfig } from './config';
import { Db } from './db/db';
import { migrate } from './db/migrate';
import { LocalFsStorage } from './storage/local-fs-storage';

const URL = process.env.TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-body-for-test')]);
const ADMIN_PW = 'Adm1n-Passw0rd!';
const reg = (n: number, over: Record<string, unknown> = {}) => ({
  firstName: 'Jasur', lastName: 'Karimov', email: `e2e${n}@example.com`, phone: `+99893${String(1000000 + n)}`,
  password: 'secret-pass-1', birthDate: '2000-05-10', acceptTos: true, acceptPrivacy: true, ...over,
});

suite('HTTP e2e', () => {
  let app: INestApplication; let db: Db; let cfg: AppConfig; let dir: string; let server: ReturnType<INestApplication['getHttpServer']>;

  const client = async () => {
    const agent = request.agent(server);
    const token = (await agent.get('/api/v1/csrf')).body.csrfToken as string;
    return {
      agent, token,
      post: (url: string, body?: unknown) => agent.post(`/api/v1${url}`).set('X-CSRF-Token', token).send(body as object),
      get: (url: string) => agent.get(`/api/v1${url}`),
      upload: (type: string, data: Buffer) => agent.post('/api/v1/verification/documents').set('X-CSRF-Token', token).set('Content-Type', type).send(data),
    };
  };
  const emailCode = async (email: string) =>
    (await db.query("SELECT payload FROM notification_outbox WHERE payload->>'to'=$1 ORDER BY id DESC LIMIT 1", [email])).rows[0].payload.data.code as string;
  const makeAdmin = async (email = 'head@x.uz') => {
    await db.query("INSERT INTO admins (email, password_hash, first_name, last_name, role_id) VALUES ($1,$2,'Bosh','Admin',(SELECT id FROM roles WHERE key='HEAD_ADMIN')) ON CONFLICT DO NOTHING", [email, await hashPassword(ADMIN_PW)]);
  };

  beforeAll(async () => {
    if (!/test/.test(URL!)) throw new Error('TEST_DATABASE_URL nomida "test" bo\'lishi shart');
    dir = mkdtempSync(join(tmpdir(), 'mafkura-e2e-'));
    cfg = loadConfig({ DATABASE_URL: URL!, CODE_SECRET: 'c'.repeat(40), FILE_URL_SECRET: 'f'.repeat(40), STORAGE_DIR: dir,
      CORS_ORIGIN: 'http://localhost:3000', ADMIN_TELEGRAM_LINKS: 'https://t.me/admin1', NODE_ENV: 'test' });
    const mod = await Test.createTestingModule({ imports: [AppModule.forRoot(cfg)] }).compile();
    app = mod.createNestApplication(); configureApp(app, cfg); await app.init();
    db = app.get(Db); server = app.getHttpServer();
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await migrate(db);
  });
  afterAll(async () => { await app.close(); await db.end(); rmSync(dir, { recursive: true, force: true }); });
  beforeEach(async () => { await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await migrate(db); });

  it('CSRF: tokensiz POST rad etiladi, begona Origin rad etiladi, GET /csrf cookie beradi', async () => {
    const r1 = await request(server).post('/api/v1/auth/register').send(reg(1));
    expect(r1.status).toBe(403); expect(r1.body.error.code).toBe('CSRF_INVALID');
    const c = await client();
    const r2 = await c.agent.post('/api/v1/auth/register').set('X-CSRF-Token', c.token).set('Origin', 'https://evil.example').send(reg(1));
    expect(r2.status).toBe(403);
    const r3 = await c.agent.post('/api/v1/auth/register').set('X-CSRF-Token', 'noto\'g\'ri').send(reg(1));
    expect(r3.status).toBe(403);
    const ok = await c.post('/auth/register', reg(1));
    expect(ok.status).toBe(201);
  });

  it('xavfsizlik sarlavhalari va xato formati (stack chiqmaydi)', async () => {
    const r = await request(server).get('/api/v1/yoq-sahifa');
    expect(r.status).toBe(404); expect(r.body).toEqual({ error: { code: 'NOT_FOUND' } });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    const c = await client();
    const bad = await c.agent.post('/api/v1/auth/login').set('X-CSRF-Token', c.token).set('Content-Type', 'application/json').send('{"email":');
    expect(bad.status).toBe(400); expect(bad.body.error.code).toBe('BAD_REQUEST');
  });

  it('ro\'yxatdan o\'tish: validatsiya (16 yosh) va takroriy email/telefon', async () => {
    const c = await client();
    const young = await c.post('/auth/register', reg(2, { birthDate: '2015-01-01' }));
    expect(young.status).toBe(400); expect(young.body.error.details.fields.birthDate).toBe('UNDER_MIN_AGE');
    expect((await c.post('/auth/register', reg(2, { acceptTos: false }))).status).toBe(400);
    expect((await c.post('/auth/register', reg(2))).status).toBe(201);
    expect((await c.post('/auth/register', reg(2, { phone: '+998931999999' }))).body.error.code).toBe('EMAIL_TAKEN');
    expect((await c.post('/auth/register', reg(3, { phone: reg(2).phone }))).body.error.code).toBe('PHONE_TAKEN');
  });

  it('to\'liq yo\'l: ro\'yxat → email → login → hujjat → admin tekshiruvi → FULL → logout', async () => {
    const u = await client(); const r = reg(10);
    await u.post('/auth/register', r);
    expect((await u.post('/auth/login', { email: r.email, password: r.password })).body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await u.post('/auth/verify-email', { email: r.email, code: '000000' })).body.error.code).toBe('INVALID_CODE');
    expect((await u.post('/auth/verify-email', { email: r.email, code: await emailCode(r.email) })).status).toBe(200);

    const login = await u.post('/auth/login', { email: r.email, password: r.password });
    expect(login.status).toBe(200); expect(login.body.access).toBe('VERIFICATION_ONLY');
    const sid = (login.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith('sid='))!;
    expect(sid).toContain('HttpOnly'); expect(sid).toContain('SameSite=Lax');
    expect(JSON.stringify(login.body)).not.toContain('passwordHash');

    expect((await u.get('/auth/me')).body.user.email).toBe(r.email);
    expect((await request(server).get('/api/v1/auth/me')).status).toBe(401);
    expect((await u.get('/verification/status')).body).toMatchObject({ userStatus: 'PENDING_DOCUMENT', attemptsLeft: 4, canSubmit: true, pending: false });

    // Fayl yuklash: noto'g'ri turlar va hajm
    expect((await u.upload('text/plain', Buffer.from('salom'))).status).toBe(415);
    expect((await u.upload('image/png', JPEG)).status).toBe(415); // deklaratsiya va haqiqiy tur mos emas
    expect((await u.upload('image/jpeg', Buffer.alloc(6 * 1024 * 1024, 0xff))).status).toBe(413);
    const up = await u.upload('image/jpeg', JPEG);
    expect(up.status).toBe(201); expect(up.body).toMatchObject({ attemptNo: 1, attemptsLeft: 3 });
    expect((await u.upload('image/jpeg', JPEG)).body.error.code).toBe('PENDING_EXISTS');

    // Foydalanuvchi admin endpointlariga kira olmaydi
    expect((await u.get('/admin/verifications/pending')).status).toBe(401);

    // Admin
    await makeAdmin();
    const a = await client();
    expect((await a.post('/admin/auth/login', { email: 'head@x.uz', password: 'noto\'g\'ri-parol' })).status).toBe(401);
    const al = await a.post('/admin/auth/login', { email: 'head@x.uz', password: ADMIN_PW });
    expect(al.status).toBe(200); expect(al.body.admin.role).toBe('HEAD_ADMIN');
    const pending = (await a.get('/admin/verifications/pending')).body;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ firstName: 'Jasur', attemptNo: 1, sla: { overdue: false } });

    const url = (await a.get(`/admin/documents/${pending[0].documentId}/url`)).body.url as string;
    const path = new globalThis.URL(url).pathname + new globalThis.URL(url).search;
    const file = await request(server).get(path); // imzoli havola — cookie shart emas
    expect(file.status).toBe(200); expect(file.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.from(file.body)).toEqual(JPEG);
    expect(file.headers['cache-control']).toContain('no-store');
    expect((await request(server).get(path.slice(0, -1) + (path.endsWith('0') ? '1' : '0'))).status).toBe(403); // imzo buzilgan
    expect((await request(server).get(path.replace('documents%2F', 'documents%2F..%2F'))).status).toBe(403);
    expect((await request(server).get('/api/v1/files/doc')).status).toBe(403);
    expect((await db.query("SELECT count(*)::int n FROM admin_audit_log WHERE action='document.view'")).rows[0].n).toBe(1);

    expect((await a.post(`/admin/verifications/${pending[0].attemptId}/review`, { approve: false })).body.error.code).toBe('REASON_REQUIRED');
    const rv = await a.post(`/admin/verifications/${pending[0].attemptId}/review`, { approve: true });
    expect(rv.status).toBe(200); expect(rv.body.newUserStatus).toBe('ACTIVE');
    expect((await a.post(`/admin/verifications/${pending[0].attemptId}/review`, { approve: true })).body.error.code).toBe('ALREADY_DECIDED');

    const me = await u.get('/auth/me');
    expect(me.body).toMatchObject({ access: 'FULL', user: { status: 'ACTIVE' } });
    expect((await u.get('/verification/status')).body.pending).toBe(false);

    // Logout sessiyani bekor qiladi
    expect((await u.post('/auth/logout')).status).toBe(204);
    expect((await u.get('/auth/me')).status).toBe(401);
    expect((await a.post('/admin/auth/logout')).status).toBe(204);
    expect((await a.get('/admin/auth/me')).status).toBe(401);
  });

  it('muddati o\'tgan imzoli havola 403', async () => {
    const old = new LocalFsStorage(dir, 'f'.repeat(40), cfg.publicBaseUrl, () => new Date(Date.now() - 3600_000));
    const key = `documents/1/${'a'.repeat(48)}`;
    await old.put(key, JPEG);
    const url = await old.signedUrl(key, 60);
    expect((await request(server).get(new globalThis.URL(url).pathname + new globalThis.URL(url).search)).status).toBe(403);
  });

  it('login bloklash: 5 xato → 429 + Retry-After; admin uchun ham', async () => {
    const u = await client(); const r = reg(20);
    await u.post('/auth/register', r); await u.post('/auth/verify-email', { email: r.email, code: await emailCode(r.email) });
    for (let i = 0; i < 5; i++) expect((await u.post('/auth/login', { email: r.email, password: 'wrong-pass-1' })).status).toBe(401);
    const locked = await u.post('/auth/login', { email: r.email, password: r.password });
    expect(locked.status).toBe(429); expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

    await makeAdmin('a2@x.uz'); const a = await client();
    for (let i = 0; i < 5; i++) await a.post('/admin/auth/login', { email: 'a2@x.uz', password: 'wrong-pass-1!A' });
    expect((await a.post('/admin/auth/login', { email: 'a2@x.uz', password: ADMIN_PW })).status).toBe(429);
  });

  it('rate limit: ro\'yxatdan o\'tish 10 so\'rovdan keyin 429', async () => {
    const c = await client(); let last = 0;
    for (let i = 0; i < 11; i++) last = (await c.post('/auth/register', { firstName: '' })).status;
    expect(last).toBe(429);
    const r = await c.post('/auth/register', { firstName: '' });
    expect(r.body.error.code).toBe('RATE_LIMITED'); expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('kodni qayta yuborish: mavjud bo\'lmagan emailga ham bir xil javob, outboxga yozilmaydi', async () => {
    const c = await client();
    expect((await c.post('/auth/resend-code', { email: 'yoq@odam.uz' })).status).toBe(202);
    expect((await db.query('SELECT count(*)::int n FROM notification_outbox')).rows[0].n).toBe(0);
    const r = reg(30); await c.post('/auth/register', r);
    expect((await c.post('/auth/resend-code', { email: r.email })).status).toBe(202);
    expect((await db.query('SELECT count(*)::int n FROM notification_outbox')).rows[0].n).toBe(2);
  });

  it('bloklangan foydalanuvchiga admin Telegram havolalari ko\'rsatiladi', async () => {
    const c = await client(); const r = reg(40);
    await c.post('/auth/register', r); await c.post('/auth/verify-email', { email: r.email, code: await emailCode(r.email) });
    await c.post('/auth/login', { email: r.email, password: r.password });
    await db.query("UPDATE users SET status='BLOCKED' WHERE email=$1", [r.email]);
    expect((await c.get('/verification/status')).status).toBe(403); // sessiya bor, lekin bloklangan
    const l = await c.post('/auth/login', { email: r.email, password: r.password });
    expect(l.status).toBe(403); expect(l.body.error.details.adminTelegramLinks).toEqual(['https://t.me/admin1']);
  });
});
