import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hash, verify, Algorithm } from '@node-rs/argon2';

// OWASP tavsiyasi: Argon2id, m=19 MiB, t=2, p=1
const ARGON = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (pw: string): Promise<string> => hash(pw, ARGON);
export const verifyPassword = (hashed: string, pw: string): Promise<boolean> =>
  verify(hashed, pw).catch(() => false);

export const generateCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function hashCode(code: string, secret: string): string {
  return createHmac('sha256', secret).update(code).digest('hex');
}
export function codeMatches(code: string, storedHash: string, secret: string): boolean {
  const a = Buffer.from(hashCode(code, secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const generateSessionToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');
export const generatePublicId = (): string => String(randomInt(10_000_000, 100_000_000));
