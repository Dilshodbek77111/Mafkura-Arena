/** Viktorina HTTP e2e: haqiqiy ilova + PostgreSQL, boshqariladigan soat bilan. */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { AppModule } from '../app.module';
import { hashPassword } from '../auth/crypto';
import { configureApp } from '../bootstrap';
import { AppConfig, loadConfig } from '../config';
import { Db } from '../db/db';
import { migrate } from '../db/migrate';

const URL = process.env.TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;
const PW = 'secret-pass-1', ADMIN_PW = 'Adm1n-Passw0rd!';
const ACTIVE_TIME = '2026-11-23T08:00:00Z'; // Toshkentda 13:00
const POINTS = (pos: number) => [10, 20, 30][(pos - 1) % 3];

suite('Viktorina e2e', () => {
  let app: INestApplication; let db: Db; let cfg: AppConfig; let dir: string; let server: ReturnType<INestApplication['getHttpServer']>;
  const clock = { t: new Date(ACTIVE_TIME) };
  let packId = 0; let questionIds: number[] = []; let n = 0;

  const client = async () => {
    const agent = request.agent(server);
    const token = (await agent.get('/api/v1/csrf')).body.csrfToken as string;
    return { post: (u: string, b?: unknown) => agent.post(`/api/v1${u}`).set('X-CSRF-Token', token).send(b as object),
      patch: (u: string, b?: unknown) => agent.patch(`/api/v1${u}`).set('X-CSRF-Token', token).send(b as object),
      del: (u: string) => agent.delete(`/api/v1${u}`).set('X-CSRF-Token', token),
      get: (u: string) => agent.get(`/api/v1${u}`) };
  };
  const user = async (status = 'ACTIVE') => {
    const email = `quiz${++n}@example.com`;
    await db.query(`INSERT INTO users (public_id, first_name, last_name, email, phone, password_hash, birth_date, status, email_verified_at, tos_version, privacy_version, tos_accepted_at)
      VALUES ($1,'Test','User',$2,$3,$4,'2000-01-01',$5,now(),'t','p',now())`, [String(50000000 + n), email, `+99894${String(2000000 + n)}`, await hashPassword(PW), status]);
    const c = await client();
    expect((await c.post('/auth/login', { email, password: PW })).status).toBe(200);
    return c;
  };
  const adminClient = async () => {
    await db.query("INSERT INTO admins (email, password_hash, first_name, last_name, role_id) VALUES ('quizadmin@x.uz',$1,'Q','A',(SELECT id FROM roles WHERE key='ADMIN')) ON CONFLICT DO NOTHING", [await hashPassword(ADMIN_PW)]);
    const c = await client();
    expect((await c.post('/admin/auth/login', { email: 'quizadmin@x.uz', password: ADMIN_PW })).status).toBe(200);
    return c;
  };
  const qBody = (i: number) => ({ text: `Savol ${i}`, correctAnswer: `javob${i}`, explanation: `Izoh ${i}`, category: 'Mantiq',
    difficulty: ['EASY', 'MEDIUM', 'HARD'][(i - 1) % 3], variants: i === 7 ? ['yettinchi'] : [] });
  const makePack = async (a: Awaited<ReturnType<typeof adminClient>>, publish = true) => {
    const ids: number[] = [];
    for (let i = 1; i <= 30; i++) ids.push((await a.post('/admin/questions', qBody(i))).body.id);
    const p = await a.post('/admin/packs', { title: 'Kunlik to‘plam', packDate: '2026-11-23', questionIds: ids });
    expect(p.status).toBe(201);
    if (publish) expect((await a.post(`/admin/packs/${p.body.id}/publish`)).status).toBe(200);
    return { packId: p.body.id as number, ids };
  };
  const answerAll = async (u: Awaited<ReturnType<typeof user>>, attemptId: number, from: number, to: number) => {
    for (let pos = from; pos <= to; pos++) {
      if (pos > 1) expect((await u.post(`/quiz/attempts/${attemptId}/next`)).status).toBe(200);
      expect((await u.post(`/quiz/attempts/${attemptId}/answer`, { text: `javob${pos}` })).status).toBe(200);
    }
  };

  beforeAll(async () => {
    if (!/test/.test(URL!)) throw new Error('TEST_DATABASE_URL nomida "test" bo\'lishi shart');
    dir = mkdtempSync(join(tmpdir(), 'mafkura-quiz-'));
    cfg = loadConfig({ DATABASE_URL: URL!, CODE_SECRET: 'c'.repeat(40), FILE_URL_SECRET: 'f'.repeat(40), STORAGE_DIR: dir, CORS_ORIGIN: 'http://localhost:3000', NODE_ENV: 'test' });
    const mod = await Test.createTestingModule({ imports: [AppModule.forRoot(cfg, { now: () => clock.t })] }).compile();
    app = mod.createNestApplication(); configureApp(app, cfg); await app.init();
    db = app.get(Db); server = app.getHttpServer();
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await migrate(db);
    const a = await adminClient(); const made = await makePack(a); packId = made.packId; questionIds = made.ids;
  });
  afterAll(async () => { await app.close(); await db.end(); rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { clock.t = new Date(ACTIVE_TIME); });

  it('admin: validatsiya, 30 savol qoidasi, ikki marta e\'lon qilib bo\'lmaydi, audit', async () => {
    const a = await adminClient();
    expect((await a.post('/admin/questions', { ...qBody(1), difficulty: 'JUDA_QIYIN' })).body.error.code).toBe('VALIDATION');
    expect((await a.post('/admin/questions', { text: '', correctAnswer: 'x', category: 'c', difficulty: 'EASY' })).status).toBe(400);
    expect((await a.post('/admin/packs', { title: 'kam', questionIds: questionIds.slice(0, 29) })).body.error.code).toBe('PACK_INVALID');
    expect((await a.post('/admin/packs', { title: 'takror', questionIds: [...questionIds.slice(0, 29), questionIds[0]] })).body.error.code).toBe('PACK_INVALID');
    const draft = await makePack(a, false);
    await a.del(`/admin/questions/${draft.ids[0]}`);
    expect((await a.post(`/admin/packs/${draft.packId}/publish`)).body.error.code).toBe('PACK_INVALID'); // faolsiz savol
    expect((await a.post(`/admin/packs/${packId}/publish`)).body.error.code).toBe('PACK_PUBLISHED');
    expect((await request(server).get('/api/v1/admin/questions')).status).toBe(401);
    expect((await db.query("SELECT count(*)::int n FROM admin_audit_log WHERE action IN ('question.create','pack.create','pack.publish','question.delete')")).rows[0].n).toBeGreaterThan(60);
    const u = await user();
    expect((await u.get('/admin/questions')).status).toBe(401); // oddiy foydalanuvchi admin emas
  });

  it('e\'lon qilinmagan to\'plam topilmaydi; ACTIVE bo\'lmagan foydalanuvchiga viktorina yopiq', async () => {
    const a = await adminClient(); const draft = await makePack(a, false);
    const u = await user();
    expect((await u.post(`/quiz/packs/${draft.packId}/start`)).body.error.code).toBe('PACK_NOT_FOUND');
    const pend = await user('PENDING_DOCUMENT');
    const r = await pend.get('/quiz/packs');
    expect(r.status).toBe(403); expect(r.body.error.details.reason).toBe('VERIFICATION_REQUIRED');
  });

  it('to\'liq o\'tish: to\'g\'ri/noto\'g\'ri/vaqt tugashi/59-soniya, davom ettirish, ball daftari', async () => {
    const u = await user();
    expect((await u.get('/quiz/packs')).body.find((p: { id: number }) => p.id === packId).attempt).toBeNull();
    const s0 = await u.post(`/quiz/packs/${packId}/start`);
    expect(s0.status).toBe(200);
    const id = s0.body.attemptId as number;
    expect(s0.body.current).toMatchObject({ position: 1, text: 'Savol 1', remainingSeconds: 60, points: 10 });
    expect(JSON.stringify(s0.body)).not.toContain('javob1');   // to'g'ri javob oldindan oshkor bo'lmaydi
    expect(JSON.stringify(s0.body)).not.toContain('Izoh 1');

    const a1 = await u.post(`/quiz/attempts/${id}/answer`, { text: '  JAVOB1!  ' });
    expect(a1.body.result).toMatchObject({ status: 'CORRECT', awardedPoints: 10, correctAnswer: 'javob1', explanation: 'Izoh 1' });
    expect(a1.body.state).toMatchObject({ current: null, canAdvance: true, answered: 1, points: 10 });
    expect((await u.post(`/quiz/attempts/${id}/answer`, { text: 'javob1' })).body.error.code).toBe('NO_OPEN_QUESTION'); // birinchi javob rasmiy

    expect((await u.post(`/quiz/attempts/${id}/next`)).body.current.position).toBe(2);
    expect((await u.post(`/quiz/attempts/${id}/next`)).body.error.code).toBe('QUESTION_OPEN');
    expect((await u.post(`/quiz/attempts/${id}/answer`, { text: 'xato' })).body.result).toMatchObject({ status: 'WRONG', awardedPoints: 0 });

    await u.post(`/quiz/attempts/${id}/next`);                       // 3-savol
    clock.t = new Date(clock.t.getTime() + 61_000);                    // 61 soniya o'tdi
    const timedOut = await u.get(`/quiz/attempts/${id}`);
    expect(timedOut.body.current).toBeNull();
    expect(timedOut.body.lastResult).toMatchObject({ position: 3, status: 'UNANSWERED', awardedPoints: 0, correctAnswer: 'javob3' });
    expect((await u.post(`/quiz/attempts/${id}/answer`, { text: 'javob3' })).body.error.code).toBe('NO_OPEN_QUESTION');

    await u.post(`/quiz/attempts/${id}/next`);                       // 4-savol
    clock.t = new Date(clock.t.getTime() + 59_000);                    // 59-soniya: hali qabul qilinadi
    expect((await u.post(`/quiz/attempts/${id}/answer`, { text: 'javob4' })).body.result.status).toBe('CORRECT');

    // "Brauzerni yangilash / qayta kirish": alohida sessiya shu holatni ko'radi, yangi urinish yaratilmaydi
    const again = await u.post(`/quiz/packs/${packId}/start`);
    expect(again.body.attemptId).toBe(id);
    expect(again.body).toMatchObject({ answered: 4, canAdvance: true });
    expect((await db.query('SELECT count(*)::int n FROM quiz_attempts WHERE user_id=(SELECT id FROM users ORDER BY id DESC LIMIT 1)')).rows[0].n).toBe(1);

    await answerAll(u, id, 5, 30);
    const fin = await u.get(`/quiz/attempts/${id}`);
    expect(fin.body).toMatchObject({ status: 'FINISHED', answered: 30, canAdvance: false });
    expect(fin.body.lastResult.position).toBe(30);
    const expected = Array.from({ length: 30 }, (_, i) => i + 1).filter((p) => ![2, 3].includes(p)).reduce((s, p) => s + POINTS(p), 0);
    expect(fin.body.points).toBe(expected);
    expect((await u.post(`/quiz/attempts/${id}/next`)).status).toBe(200); // tugagan urinishda xavfsiz

    const uid = (await db.query('SELECT user_id FROM quiz_attempts WHERE id=$1', [id])).rows[0].user_id;
    expect((await db.query('SELECT count(*)::int n, sum(amount)::int total FROM score_ledger WHERE user_id=$1', [uid])).rows[0]).toEqual({ n: 28, total: expected });
    expect((await db.query('SELECT total FROM user_scores WHERE user_id=$1', [uid])).rows[0].total).toBe(expected);
    expect((await db.query('SELECT raw_points FROM quiz_attempts WHERE id=$1', [id])).rows[0].raw_points).toBe(expected);

    // Boshqa foydalanuvchi bu urinishni ko'ra olmaydi
    const other = await user();
    expect((await other.get(`/quiz/attempts/${id}`)).status).toBe(404);
    expect((await u.get('/quiz/packs')).body.find((p: { id: number }) => p.id === packId).attempt).toMatchObject({ id, status: 'FINISHED', answered: 30 });
  });

  it('60-soniya chegarasida deadline tugashi bilan javob qabul qilinmaydi', async () => {
    const u = await user();
    const id = (await u.post(`/quiz/packs/${packId}/start`)).body.attemptId as number;
    clock.t = new Date(clock.t.getTime() + 60_000);
    const expired = await u.post(`/quiz/attempts/${id}/answer`, { text: 'javob1' });
    expect(expired.body.error.code).toBe('NO_OPEN_QUESTION');
    const state = await u.get(`/quiz/attempts/${id}`);
    expect(state.body.lastResult).toMatchObject({ position: 1, status: 'UNANSWERED' });
  });

  it('muqobil javob variantlari va kirill/apostrof farqlari qabul qilinadi', async () => {
    const u = await user(); const s = await u.post(`/quiz/packs/${packId}/start`); const id = s.body.attemptId;
    await answerAll(u, id, 1, 6);
    await u.post(`/quiz/attempts/${id}/next`);
    // 7-savolning muqobil varianti "yettinchi"; kirillcha yozilgan javob ham qabul qilinadi
    expect((await u.post(`/quiz/attempts/${id}/answer`, { text: 'Йеттинчи ' })).body.result).toMatchObject({ status: 'CORRECT', awardedPoints: POINTS(7) });
  });

  it('snapshot: admin savolni o\'zgartirsa ham boshlangan urinish o\'zgarmaydi; DB o\'zgartirishga yo\'l qo\'ymaydi', async () => {
    const u = await user(); const a = await adminClient();
    const id = (await u.post(`/quiz/packs/${packId}/start`)).body.attemptId;
    expect((await a.patch(`/admin/questions/${questionIds[0]}`, { text: 'Butunlay boshqa savol', correctAnswer: 'boshqa' })).status).toBe(200);
    const st = await u.get(`/quiz/attempts/${id}`);
    expect(st.body.current.text).toBe('Savol 1');
    expect((await u.post(`/quiz/attempts/${id}/answer`, { text: 'javob1' })).body.result.status).toBe('CORRECT');
    await a.patch(`/admin/questions/${questionIds[0]}`, { text: 'Savol 1', correctAnswer: 'javob1' }); // qaytarish
    await expect(db.query("UPDATE quiz_answers SET snapshot='{}'::jsonb WHERE attempt_id=$1", [id])).rejects.toThrow(/immutable/);
    await expect(db.query("UPDATE quiz_answers SET status='WRONG' WHERE attempt_id=$1 AND position=1", [id])).rejects.toThrow(/immutable/);
    await expect(db.query("UPDATE quiz_answers SET answered_at=now() WHERE attempt_id=$1 AND position=1", [id])).rejects.toThrow(/immutable/);
    await expect(db.query("UPDATE quiz_answers SET deadline_at=now() WHERE attempt_id=$1 AND position=1", [id])).rejects.toThrow(/immutable/);
    await expect(db.query("UPDATE score_ledger SET amount=999")).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM score_ledger')).rejects.toThrow(/append-only/);
  });

  it('parallel ikki javob: faqat bittasi hisoblanadi, ball bir marta yoziladi', async () => {
    const u = await user(); const id = (await u.post(`/quiz/packs/${packId}/start`)).body.attemptId;
    const res = await Promise.all([u.post(`/quiz/attempts/${id}/answer`, { text: 'javob1' }), u.post(`/quiz/attempts/${id}/answer`, { text: 'javob1' })]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await db.query("SELECT count(*)::int n FROM score_ledger WHERE idempotency_key=$1", [`quiz:main:${id}:1`])).rows[0].n).toBe(1);
  });

  it('read-only (01:00–11:00): boshlash va javob rad etiladi, ko\'rish mumkin', async () => {
    const u = await user();
    clock.t = new Date('2026-11-22T22:00:00Z');                       // 03:00 Toshkent
    const r = await u.post(`/quiz/packs/${packId}/start`);
    expect(r.status).toBe(503); expect(r.body.error).toMatchObject({ code: 'READ_ONLY', details: { reopensAt: '2026-11-23T06:00:00.000Z' } });
    expect((await u.get('/quiz/packs')).status).toBe(200);
  });

  it('01:00 tanaffusi: ochiq savol to\'xtab turadi, 11:00 da yangi 60 soniya beriladi', async () => {
    const u = await user();
    clock.t = new Date('2026-11-22T19:59:30Z');                       // 00:59:30
    const id = (await u.post(`/quiz/packs/${packId}/start`)).body.attemptId;
    clock.t = new Date('2026-11-22T20:30:00Z');                       // 01:30
    const paused = await u.get(`/quiz/attempts/${id}`);
    expect(paused.body.paused).toBe(true); expect(paused.body.current.position).toBe(1);
    expect((await u.post(`/quiz/attempts/${id}/answer`, { text: 'javob1' })).status).toBe(503);
    expect((await db.query("SELECT status FROM quiz_answers WHERE attempt_id=$1 AND position=1", [id])).rows[0].status).toBe('OPEN'); // javobsiz belgilanmagan
    clock.t = new Date('2026-11-23T06:00:00Z');                       // 11:00
    const resumed = await u.get(`/quiz/attempts/${id}`);
    expect(resumed.body.paused).toBe(false); expect(resumed.body.current.remainingSeconds).toBe(60);
    expect((await u.post(`/quiz/attempts/${id}/answer`, { text: 'javob1' })).body.result.status).toBe('CORRECT');
  });

  it('tanaffusga tushmagan muddat o\'tgan savol read-only vaqtda ham javobsiz bo\'ladi', async () => {
    const u = await user();
    clock.t = new Date('2026-11-22T18:00:00Z');                       // 23:00
    const id = (await u.post(`/quiz/packs/${packId}/start`)).body.attemptId;
    clock.t = new Date('2026-11-22T22:00:00Z');                       // 03:00
    const st = await u.get(`/quiz/attempts/${id}`);
    expect(st.body.current).toBeNull(); expect(st.body.lastResult.status).toBe('UNANSWERED');
  });
});
