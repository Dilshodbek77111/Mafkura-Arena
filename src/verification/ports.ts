import type { PoolClient } from 'pg';
import { UserStatus } from '../auth/ports';

export interface AttemptRecord {
  id: number; userId: number; attemptNo: number; status: 'PENDING' | 'APPROVED' | 'REJECTED';
  submittedAt: Date; rejectReason: string | null;
}
export interface VerificationState {
  userId: number; userStatus: UserStatus; attemptsUsed: number; extraAttempts: number; phoneVerified: boolean;
}
export interface NewDocument { storageKey: string; mime: string; sizeBytes: number; sha256: string; retentionUntil: Date }

export interface PendingItem {
  attemptId: number; userId: number; attemptNo: number; submittedAt: Date; documentId: number; firstName: string; lastName: string;
}

export interface VerificationRepo {
  getState(userId: number): Promise<VerificationState | null>;
  findPendingAttempt(userId: number): Promise<AttemptRecord | null>;
  getAttempt(id: number): Promise<AttemptRecord | null>;
  /** Bitta tranzaksiyada: attempt + document yaratadi, attemptsUsed++, docStatus=PENDING. */
  createAttempt(userId: number, attemptNo: number, doc: NewDocument): Promise<AttemptRecord>;
  /** Bitta tranzaksiyada va FAQAT attempt hali PENDING bo'lsa; aks holda false (ikki admin poygasi). */
  decide(attemptId: number, d: {
    status: 'APPROVED' | 'REJECTED'; reason?: string; adminId: number; at: Date;
    retentionUntil: Date; newUserStatus: UserStatus;
  }): Promise<boolean>;
  getDocument(id: number): Promise<{ id: number; attemptId: number; userId: number; storageKey: string } | null>;
  /** extraAttempts++ va holatni DOC_REJECTED ga qaytaradi. */
  grantExtraAttempt(userId: number): Promise<void>;
  getLatestAttempt(userId: number): Promise<AttemptRecord | null>;
  listPending(limit: number): Promise<PendingItem[]>;
  listExpiredDocuments(now: Date): Promise<{ id: number; storageKey: string }[]>;
  markDocumentDeleted(id: number, at: Date): Promise<void>;
}

export interface DocStorage {
  put(key: string, data: Uint8Array, mime: string): Promise<void>;
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}
export interface AuditWriter {
  write(e: { adminId: number | null; action: string; objectType: string; objectId: string;
    oldValue?: unknown; newValue?: unknown; reason?: string }, client?: PoolClient): Promise<void>;
}
export interface UserNotifier {
  notify(userId: number, type: string, data: Record<string, unknown>): Promise<void>;
}
