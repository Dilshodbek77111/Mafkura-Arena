import { UserStatus } from '../auth/ports';
import { ForbiddenError } from '../rbac/rbac';
import {
  AttemptRecord, AuditWriter, DocStorage, NewDocument, UserNotifier, VerificationRepo, VerificationState,
} from './ports';
import {
  DEFAULT_VERIFICATION_CONFIG, reviewSla, VerificationError, VerificationService,
} from './verification.service';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const ADMIN = { id: 7, role: 'ADMIN' as const };

class FakeRepo implements VerificationRepo {
  st: VerificationState = { userId: 1, userStatus: 'PENDING_DOCUMENT', attemptsUsed: 0, extraAttempts: 0, phoneVerified: true };
  attempts: (AttemptRecord & { doc: NewDocument; deleted?: Date })[] = [];
  async getState(id: number) { return id === this.st.userId ? { ...this.st } : null; }
  async findPendingAttempt() { return this.attempts.find((a) => a.status === 'PENDING') ?? null; }
  async getAttempt(id: number) { return this.attempts.find((a) => a.id === id) ?? null; }
  async createAttempt(userId: number, attemptNo: number, doc: NewDocument) {
    const a = { id: this.attempts.length + 1, userId, attemptNo, status: 'PENDING' as const, submittedAt: new Date(), rejectReason: null, doc };
    this.attempts.push(a); this.st.attemptsUsed++; return a;
  }
  async decide(id: number, d: { status: 'APPROVED' | 'REJECTED'; reason?: string; retentionUntil: Date; newUserStatus: UserStatus }) {
    const a = this.attempts.find((x) => x.id === id)!;
    if (a.status !== 'PENDING') return false;
    a.status = d.status; a.rejectReason = d.reason ?? null; a.doc.retentionUntil = d.retentionUntil;
    this.st.userStatus = d.newUserStatus; return true;
  }
  async getDocument(id: number) { const a = this.attempts[id - 1]; return a ? { id, attemptId: a.id, userId: a.userId, storageKey: a.doc.storageKey } : null; }
  async grantExtraAttempt() { this.st.extraAttempts++; this.st.userStatus = 'DOC_REJECTED'; }
  async getLatestAttempt(userId: number) { return [...this.attempts].reverse().find((a) => a.userId === userId) ?? null; }
  async listPending() { return []; }
  async listExpiredDocuments(now: Date) {
    return this.attempts.filter((a) => !a.deleted && a.doc.retentionUntil <= now).map((a) => ({ id: a.id, storageKey: a.doc.storageKey }));
  }
  async markDocumentDeleted(id: number, at: Date) { this.attempts[id - 1].deleted = at; }
}
class FakeStorage implements DocStorage {
  files = new Map<string, Uint8Array>();
  async put(k: string, d: Uint8Array) { this.files.set(k, d); }
  async signedUrl(k: string, ttl: number) { return `https://storage.test/${k}?ttl=${ttl}&sig=x`; }
  async delete(k: string) { this.files.delete(k); }
}
class FakeAudit implements AuditWriter { rows: { action: string; adminId: number | null; reason?: string }[] = []; async write(e: { action: string; adminId: number | null; reason?: string }) { this.rows.push(e); } }
class FakeNotifier implements UserNotifier { rows: { type: string; data: Record<string, unknown> }[] = []; async notify(_u: number, type: string, data: Record<string, unknown>) { this.rows.push({ type, data }); } }

function setup(cfg = {}) {
  let now = new Date('2026-11-22T10:00:00Z');
  const repo = new FakeRepo(), storage = new FakeStorage(), audit = new FakeAudit(), notifier = new FakeNotifier();
  const svc = new VerificationService({ repo, storage, audit, notifier, now: () => now, config: { ...DEFAULT_VERIFICATION_CONFIG, ...cfg } });
  return { svc, repo, storage, audit, notifier, setNow: (d: Date) => (now = d) };
}
const err = async (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e instanceof VerificationError ? e.code : e instanceof ForbiddenError ? 'FORBIDDEN' : `ERR:${e}`));

describe('hujjat yuborish', () => {
  it('saqlanadi: tasodifiy private kalit, PENDING, 4 urinishdan 3 tasi qoldi', async () => {
    const s = setup();
    const r = await s.svc.submit(1, { data: JPEG, declaredMime: 'image/jpeg' });
    expect(r).toMatchObject({ attemptNo: 1, attemptsLeft: 3, warning: false });
    const key = s.repo.attempts[0].doc.storageKey;
    expect(key).toMatch(/^documents\/1\/[0-9a-f]{48}$/);
    expect(s.storage.files.has(key)).toBe(true);
  });
  it('fayl turi: deklaratsiya yolg\'on yoki ruxsat etilmagan format rad etiladi', async () => {
    const s = setup();
    expect(await err(s.svc.submit(1, { data: JPEG, declaredMime: 'image/png' }))).toBe('FILE_TYPE_INVALID');
    expect(await err(s.svc.submit(1, { data: new TextEncoder().encode('<html>') }))).toBe('FILE_TYPE_INVALID');
    expect(await err(s.svc.submit(1, { data: new Uint8Array(6 * 1024 * 1024) }))).toBe('FILE_TOO_LARGE');
    expect(s.storage.files.size).toBe(0);
  });
  it('kutilayotgan ariza bor bo\'lsa yangisi qabul qilinmaydi; faol/bloklangan holatda ham', async () => {
    const s = setup();
    await s.svc.submit(1, { data: JPEG });
    expect(await err(s.svc.submit(1, { data: JPEG }))).toBe('PENDING_EXISTS');
    const s2 = setup(); s2.repo.st.userStatus = 'ACTIVE';
    expect(await err(s2.svc.submit(1, { data: JPEG }))).toBe('NOT_ALLOWED_STATE');
    s2.repo.st.userStatus = 'BLOCKED';
    expect(await err(s2.svc.submit(1, { data: JPEG }))).toBe('NOT_ALLOWED_STATE');
  });
});

describe('4 urinish va bloklash', () => {
  it('2-urinishdan ogohlantirish; 4-rad etishda BLOCKED', async () => {
    const s = setup();
    for (let i = 1; i <= 4; i++) {
      const r = await s.svc.submit(1, { data: JPEG });
      expect(r.warning).toBe(i >= 2);
      const out = await s.svc.review(ADMIN, r.attemptId, { approve: false, reason: 'Ism ko\'rinmayapti' });
      expect(out.newUserStatus).toBe(i < 4 ? 'DOC_REJECTED' : 'BLOCKED');
    }
    expect(s.notifier.rows.at(-1)?.data.blocked).toBe(true);
    s.repo.st.userStatus = 'DOC_REJECTED'; // hatto holat noto'g'ri bo'lsa ham urinishlar tugagan
    expect(await err(s.svc.submit(1, { data: JPEG }))).toBe('NO_ATTEMPTS_LEFT');
  });
  it('admin qo\'shimcha imkoniyat beradi: DOC_REJECTED, yana 1 urinish, audit logda sabab', async () => {
    const s = setup();
    for (let i = 0; i < 4; i++) { const r = await s.svc.submit(1, { data: JPEG }); await s.svc.review(ADMIN, r.attemptId, { approve: false, reason: 'x' }); }
    expect(await err(s.svc.grantExtraAttempt(ADMIN, 1, ''))).toBe('REASON_REQUIRED');
    await s.svc.grantExtraAttempt(ADMIN, 1, 'Foydalanuvchi Telegram orqali murojaat qildi');
    expect(s.audit.rows.at(-1)).toMatchObject({ action: 'verification.grantExtraAttempt', reason: expect.any(String) });
    const r = await s.svc.submit(1, { data: JPEG });
    expect(r.attemptNo).toBe(5);
    expect((await s.svc.review(ADMIN, r.attemptId, { approve: false, reason: 'x' })).newUserStatus).toBe('BLOCKED');
  });
  it('bloklanmagan foydalanuvchiga qo\'shimcha imkoniyat berib bo\'lmaydi', async () => {
    expect(await err(setup().svc.grantExtraAttempt(ADMIN, 1, 'sabab'))).toBe('NOT_BLOCKED');
  });
});

describe('admin qarori', () => {
  it('tasdiqlash: ACTIVE, 90 kunlik saqlash, audit + xabarnoma', async () => {
    const s = setup(); const r = await s.svc.submit(1, { data: JPEG });
    expect((await s.svc.review(ADMIN, r.attemptId, { approve: true })).newUserStatus).toBe('ACTIVE');
    expect(s.repo.attempts[0].doc.retentionUntil.toISOString()).toBe('2027-02-20T10:00:00.000Z');
    expect(s.audit.rows.at(-1)?.action).toBe('verification.approve');
    expect(s.notifier.rows.at(-1)?.type).toBe('verification.approved');
  });
  it('telefon tasdiqlanmagan bo\'lsa ACTIVE bo\'lmaydi (v2: SMS majburiy)', async () => {
    const s = setup({ requirePhoneVerified: true }); s.repo.st.phoneVerified = false;
    const r = await s.svc.submit(1, { data: JPEG });
    expect((await s.svc.review(ADMIN, r.attemptId, { approve: true })).newUserStatus).toBe('PENDING_DOCUMENT');
  });
  it('rad etish: sabab majburiy, 30 kunlik saqlash', async () => {
    const s = setup(); const r = await s.svc.submit(1, { data: JPEG });
    expect(await err(s.svc.review(ADMIN, r.attemptId, { approve: false, reason: '  ' }))).toBe('REASON_REQUIRED');
    await s.svc.review(ADMIN, r.attemptId, { approve: false, reason: 'Xira rasm' });
    expect(s.repo.attempts[0].doc.retentionUntil.toISOString()).toBe('2026-12-22T10:00:00.000Z');
  });
  it('ikkinchi admin bir vaqtda qaror chiqarsa ALREADY_DECIDED', async () => {
    const s = setup(); const r = await s.svc.submit(1, { data: JPEG });
    await s.svc.review(ADMIN, r.attemptId, { approve: true });
    expect(await err(s.svc.review({ id: 8, role: 'ADMIN' }, r.attemptId, { approve: false, reason: 'x' }))).toBe('ALREADY_DECIDED');
  });
  it('mavjud bo\'lmagan ariza', async () => {
    expect(await err(setup().svc.review(ADMIN, 99, { approve: true }))).toBe('ATTEMPT_NOT_FOUND');
  });
});

describe('hujjatni ko\'rish va saqlash muddati', () => {
  it('ko\'rish audit logga yoziladi, URL imzolangan va qisqa muddatli', async () => {
    const s = setup(); await s.svc.submit(1, { data: JPEG });
    const url = await s.svc.viewDocument(ADMIN, 1);
    expect(url).toContain('ttl=60'); expect(url).toContain('sig=');
    expect(s.audit.rows.at(-1)).toMatchObject({ action: 'document.view', adminId: 7 });
    expect(await err(s.svc.viewDocument(ADMIN, 99))).toBe('DOCUMENT_NOT_FOUND');
  });
  it('purge: sukut bo\'yicha O\'CHIQ; yoqilganda faqat muddati o\'tganlarni o\'chiradi', async () => {
    const off = setup(); const r0 = await off.svc.submit(1, { data: JPEG });
    await off.svc.review(ADMIN, r0.attemptId, { approve: false, reason: 'x' });
    off.setNow(new Date('2027-06-01T00:00:00Z'));
    expect(await off.svc.purgeExpired()).toBe(0);
    expect(off.storage.files.size).toBe(1);

    const on = setup({ autoPurgeEnabled: true }); const r1 = await on.svc.submit(1, { data: JPEG });
    await on.svc.review(ADMIN, r1.attemptId, { approve: false, reason: 'x' });
    on.setNow(new Date('2026-12-01T00:00:00Z'));
    expect(await on.svc.purgeExpired()).toBe(0);          // 30 kun hali o'tmagan
    on.setNow(new Date('2026-12-23T00:00:00Z'));
    expect(await on.svc.purgeExpired()).toBe(1);
    expect(on.storage.files.size).toBe(0);
    expect(on.audit.rows.at(-1)?.action).toBe('document.purge');
  });
});

describe('RBAC va tekshiruv muddati', () => {
  it('oddiy Admin hujjat qarorini chiqara oladi (document.review ruxsati bor)', async () => {
    const s = setup(); const r = await s.svc.submit(1, { data: JPEG });
    expect(await err(s.svc.review({ id: 1, role: 'ADMIN' }, r.attemptId, { approve: true }))).toBe('OK');
  });
  it('4 soatlik muddat faqat faol vaqtda sanaladi', () => {
    // 23:00 Toshkentda yuborilgan (18:00Z) → 01:00 gacha 2 soat faol, 11:00 dan yana 2 soat → 13:00 da tugaydi
    const sub = new Date('2026-11-22T18:00:00Z');
    expect(reviewSla(sub, new Date('2026-11-22T20:00:00Z'))).toMatchObject({ activeSecondsUsed: 7200, overdue: false }); // 01:00
    expect(reviewSla(sub, new Date('2026-11-23T05:00:00Z'))).toMatchObject({ activeSecondsUsed: 7200, overdue: false }); // 10:00 — to'xtab turibdi
    expect(reviewSla(sub, new Date('2026-11-23T07:59:00Z')).overdue).toBe(false);
    expect(reviewSla(sub, new Date('2026-11-23T08:00:00Z'))).toMatchObject({ activeSecondsLeft: 0, overdue: true }); // 13:00
  });
});
