export type UserStatus =
  | 'PENDING_EMAIL' | 'PENDING_DOCUMENT' | 'ACTIVE' | 'DOC_REJECTED'
  | 'BLOCKED' | 'DELETION_PENDING' | 'DELETED';

export interface UserRecord {
  id: number; publicId: string; firstName: string; lastName: string;
  email: string; phone: string; passwordHash: string; status: UserStatus;
  emailVerifiedAt: Date | null;
}
export interface NewUser {
  publicId: string; firstName: string; lastName: string; email: string; phone: string;
  passwordHash: string; birthDate: Date; tosVersion: string; privacyVersion: string; tosAcceptedAt: Date;
}

/** Unique cheklov buzilganda repo shuni tashlaydi (race condition himoyasi). */
export class DuplicateError extends Error {
  constructor(public readonly field: 'email' | 'phone' | 'publicId') { super(`duplicate ${field}`); }
}

export interface UserRepo {
  findByEmail(email: string): Promise<UserRecord | null>;
  findByPhone(phone: string): Promise<UserRecord | null>;
  findById(id: number): Promise<UserRecord | null>;
  create(u: NewUser): Promise<UserRecord>; // DuplicateError tashlashi mumkin
  markEmailVerified(id: number, at: Date): Promise<void>; // status → PENDING_DOCUMENT
}

export interface CodeRecord { id: number; codeHash: string; expiresAt: Date; attempts: number; }
export interface CodeRepo {
  /** Oldingi faol kodlarni bekor qilib, yangisini saqlaydi. */
  replace(userId: number, channel: 'EMAIL' | 'PHONE', codeHash: string, expiresAt: Date): Promise<CodeRecord>;
  findActive(userId: number, channel: 'EMAIL' | 'PHONE'): Promise<CodeRecord | null>;
  incrementAttempts(id: number): Promise<void>;
  consume(id: number, at: Date): Promise<void>;
}

export interface SessionRecord { id: number; userId: number; expiresAt: Date; revokedAt: Date | null; }
export interface SessionRepo {
  create(s: { userId: number; tokenHash: string; expiresAt: Date; ip?: string; userAgent?: string }): Promise<SessionRecord>;
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  revoke(id: number, at: Date): Promise<void>;
}

export interface ThrottleState { failures: number; lockedUntil: Date | null; }
export interface LoginThrottleRepo {
  get(key: string): Promise<ThrottleState | null>;
  save(key: string, state: ThrottleState): Promise<void>;
  clear(key: string): Promise<void>;
}

/** Persistent outbox (NotificationOutbox) ga yozadi; dedupKey takroriy yuborishni to'sadi. */
/** Persistent outbox (NotificationOutbox) ga yozadi; dedupKey takroriy yuborishni to'sadi. */
export interface EmailOutbox {
  enqueue(m: {
    userId: number;
    dedupKey: string;
    to: string;
    template: string;
    data: Record<string, unknown>;
    runAt: Date;
    expiresAt: Date;
  }): Promise<void>;
}
