import { randomBytes, createHash } from 'node:crypto';
import { activeSecondsBetween } from '../domain/time';
import { AdminRole, requirePermission } from '../rbac/rbac';
import { MAX_DOCUMENT_BYTES, sniffMime } from './file-type';
import { AuditWriter, DocStorage, UserNotifier, VerificationRepo } from './ports';

export type VerificationErrorCode =
  | 'NOT_ALLOWED_STATE' | 'PENDING_EXISTS' | 'NO_ATTEMPTS_LEFT' | 'FILE_TOO_LARGE' | 'FILE_TYPE_INVALID'
  | 'ATTEMPT_NOT_FOUND' | 'ALREADY_DECIDED' | 'REASON_REQUIRED' | 'DOCUMENT_NOT_FOUND' | 'USER_NOT_FOUND'
  | 'NOT_BLOCKED';
export class VerificationError extends Error {
  constructor(public readonly code: VerificationErrorCode) { super(code); }
}

export const MAX_ATTEMPTS = 4;
export const REVIEW_SLA_ACTIVE_SECONDS = 4 * 3600;
const DAY = 24 * 3600 * 1000;

export interface VerificationConfig {
  approvedRetentionDays: number;  // v2: 90 (qonun bilan tekshiriladi)
  rejectedRetentionDays: number;  // v2: 30
  requirePhoneVerified: boolean;  // v2: SMS tasdig'i majburiy
  autoPurgeEnabled: boolean;      // qonuniy tekshiruvdan keyingina true
  signedUrlTtlSeconds: number;
}
export const DEFAULT_VERIFICATION_CONFIG: VerificationConfig = {
  approvedRetentionDays: 90, rejectedRetentionDays: 30, requirePhoneVerified: false,
  autoPurgeEnabled: false, signedUrlTtlSeconds: 60,
};

export interface AdminActor { id: number; role: AdminRole }

/** Tekshiruv muddati FAOL vaqt bo'yicha: 01:00–11:00 hisoblanmaydi. */
export function reviewSla(submittedAt: Date, now: Date) {
  const used = activeSecondsBetween(submittedAt, now);
  return { activeSecondsUsed: used, activeSecondsLeft: Math.max(0, REVIEW_SLA_ACTIVE_SECONDS - used), overdue: used >= REVIEW_SLA_ACTIVE_SECONDS };
}

export class VerificationService {
  constructor(private readonly d: {
    repo: VerificationRepo; storage: DocStorage; audit: AuditWriter; notifier: UserNotifier;
    config: VerificationConfig; now: () => Date;
  }) {}

  /** Foydalanuvchining o'z holati (verification sahifasi uchun). */
  async status(userId: number) {
    const st = await this.d.repo.getState(userId);
    if (!st) throw new VerificationError('USER_NOT_FOUND');
    const pending = await this.d.repo.findPendingAttempt(userId);
    const last = await this.d.repo.getLatestAttempt(userId);
    const max = MAX_ATTEMPTS + st.extraAttempts;
    return {
      userStatus: st.userStatus, attemptsUsed: st.attemptsUsed, attemptsLeft: Math.max(0, max - st.attemptsUsed),
      pending: pending !== null, lastRejectReason: last?.status === 'REJECTED' ? last.rejectReason : null,
      canSubmit: !pending && (st.userStatus === 'PENDING_DOCUMENT' || st.userStatus === 'DOC_REJECTED') && st.attemptsUsed < max,
    };
  }

  /** Admin navbati: eng eskisi birinchi, 4 soatlik faol muddat holati bilan. */
  async listPending(admin: AdminActor) {
    requirePermission(admin.role, 'document.review');
    const now = this.d.now();
    return (await this.d.repo.listPending(100)).map((i) => ({ ...i, sla: reviewSla(i.submittedAt, now) }));
  }

  async submit(userId: number, file: { data: Uint8Array; declaredMime?: string }) {
    const now = this.d.now();
    const st = await this.d.repo.getState(userId);
    if (!st) throw new VerificationError('USER_NOT_FOUND');
    if (st.userStatus !== 'PENDING_DOCUMENT' && st.userStatus !== 'DOC_REJECTED') throw new VerificationError('NOT_ALLOWED_STATE');
    if (await this.d.repo.findPendingAttempt(userId)) throw new VerificationError('PENDING_EXISTS');
    const max = MAX_ATTEMPTS + st.extraAttempts;
    if (st.attemptsUsed >= max) throw new VerificationError('NO_ATTEMPTS_LEFT');

    if (file.data.byteLength > MAX_DOCUMENT_BYTES || file.data.byteLength === 0) throw new VerificationError('FILE_TOO_LARGE');
    const mime = sniffMime(file.data);
    if (!mime || (file.declaredMime && file.declaredMime !== mime)) throw new VerificationError('FILE_TYPE_INVALID');

    const storageKey = `documents/${userId}/${randomBytes(24).toString('hex')}`; // taxmin qilib bo'lmaydigan kalit
    await this.d.storage.put(storageKey, file.data, mime);
    const attemptNo = st.attemptsUsed + 1;
    const attempt = await this.d.repo.createAttempt(userId, attemptNo, {
      storageKey, mime, sizeBytes: file.data.byteLength,
      sha256: createHash('sha256').update(file.data).digest('hex'),
      retentionUntil: new Date(now.getTime() + this.d.config.rejectedRetentionDays * DAY), // vaqtinchalik; qaror bilan yangilanadi
    });
    const attemptsLeft = max - attemptNo;
    // [TEMP] D-026: 2-urinishdan boshlab ogohlantirish
    return { attemptId: attempt.id, attemptNo, attemptsLeft, warning: attemptNo >= 2 };
  }

  async review(admin: AdminActor, attemptId: number, decision: { approve: true } | { approve: false; reason: string }) {
    requirePermission(admin.role, 'document.review');
    const now = this.d.now();
    const attempt = await this.d.repo.getAttempt(attemptId);
    if (!attempt) throw new VerificationError('ATTEMPT_NOT_FOUND');
    if (attempt.status !== 'PENDING') throw new VerificationError('ALREADY_DECIDED');
    const st = (await this.d.repo.getState(attempt.userId))!;
    const cfg = this.d.config;

    let newUserStatus: 'ACTIVE' | 'PENDING_DOCUMENT' | 'DOC_REJECTED' | 'BLOCKED';
    let retentionDays: number;
    let reason: string | undefined;
    if (decision.approve) {
      // Telefon tasdiqlanmaguncha hujjat tasdiqlangan bo'lsa ham ACTIVE bo'lmaydi (v2). Hujjat holati baribir APPROVED.
      newUserStatus = !cfg.requirePhoneVerified || st.phoneVerified ? 'ACTIVE' : 'PENDING_DOCUMENT';
      retentionDays = cfg.approvedRetentionDays;
    } else {
      reason = decision.reason?.trim();
      if (!reason) throw new VerificationError('REASON_REQUIRED');
      newUserStatus = attempt.attemptNo >= MAX_ATTEMPTS + st.extraAttempts ? 'BLOCKED' : 'DOC_REJECTED';
      retentionDays = cfg.rejectedRetentionDays;
    }

    const ok = await this.d.repo.decide(attemptId, {
      status: decision.approve ? 'APPROVED' : 'REJECTED', reason, adminId: admin.id, at: now,
      retentionUntil: new Date(now.getTime() + retentionDays * DAY), newUserStatus,
    });
    if (!ok) throw new VerificationError('ALREADY_DECIDED');

    await this.d.audit.write({
      adminId: admin.id, action: decision.approve ? 'verification.approve' : 'verification.reject',
      objectType: 'VerificationAttempt', objectId: String(attemptId),
      oldValue: { userStatus: st.userStatus }, newValue: { userStatus: newUserStatus }, reason,
    });
    await this.d.notifier.notify(attempt.userId, decision.approve ? 'verification.approved' : 'verification.rejected', {
      reason, blocked: newUserStatus === 'BLOCKED',
    });
    return { newUserStatus };
  }

  /** Hujjatni ko'rish: huquq + audit log + qisqa muddatli imzolangan URL. Ommaviy URL yo'q. */
  async viewDocument(admin: AdminActor, documentId: number): Promise<string> {
    requirePermission(admin.role, 'document.view');
    const doc = await this.d.repo.getDocument(documentId);
    if (!doc) throw new VerificationError('DOCUMENT_NOT_FOUND');
    await this.d.audit.write({ adminId: admin.id, action: 'document.view', objectType: 'VerificationDocument', objectId: String(documentId) });
    return this.d.storage.signedUrl(doc.storageKey, this.d.config.signedUrlTtlSeconds);
  }

  async grantExtraAttempt(admin: AdminActor, userId: number, reason: string): Promise<void> {
    requirePermission(admin.role, 'user.review');
    if (!reason.trim()) throw new VerificationError('REASON_REQUIRED');
    const st = await this.d.repo.getState(userId);
    if (!st) throw new VerificationError('USER_NOT_FOUND');
    if (st.userStatus !== 'BLOCKED') throw new VerificationError('NOT_BLOCKED');
    await this.d.repo.grantExtraAttempt(userId);
    await this.d.audit.write({ adminId: admin.id, action: 'verification.grantExtraAttempt', objectType: 'User', objectId: String(userId),
      oldValue: { extraAttempts: st.extraAttempts }, newValue: { extraAttempts: st.extraAttempts + 1 }, reason });
  }

  /** Muddati o'tgan hujjatlarni o'chiradi. Qonuniy tekshiruvgacha config.autoPurgeEnabled=false. */
  async purgeExpired(): Promise<number> {
    if (!this.d.config.autoPurgeEnabled) return 0;
    const now = this.d.now();
    let n = 0;
    for (const doc of await this.d.repo.listExpiredDocuments(now)) {
      await this.d.storage.delete(doc.storageKey);
      await this.d.repo.markDocumentDeleted(doc.id, now);
      await this.d.audit.write({ adminId: null, action: 'document.purge', objectType: 'VerificationDocument', objectId: String(doc.id) });
      n++;
    }
    return n;
  }
}
