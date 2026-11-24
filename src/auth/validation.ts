import { TASHKENT_OFFSET_MS } from '../domain/time';

export const MIN_AGE = 16;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/** O'zbekiston raqami → "+998XXXXXXXXX" yoki null. [TEMP] faqat O'zbekiston raqamlari qabul qilinadi. */
export function normalizeUzPhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-()]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return null;
  let national: string;
  if (digits.length === 12 && digits.startsWith('998')) national = digits.slice(3);
  else if (digits.length === 9) national = digits;
  else return null;
  if (national.startsWith('0')) return null;
  return `+998${national}`;
}

/** Ism/familiya: harflar (lotin/kirill), apostrof variantlari, tire, bo'shliq. */
export function isValidName(raw: string): boolean {
  const s = raw.trim();
  return s.length >= 1 && s.length <= 60 && /^[\p{L}][\p{L}\p{M}'ʻʼ’‘`\- ]*$/u.test(s);
}

/** "YYYY-MM-DD" → UTC sana yoki null (mavjud bo'lmagan sanalar rad etiladi). */
export function parseBirthDate(raw: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw ? null : d;
}

/** To'liq yosh (Toshkent sanasi bo'yicha). Tug'ilgan kunning o'zida yosh oshadi. */
export function ageInYears(birth: Date, now: Date): number {
  const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  let age = local.getUTCFullYear() - birth.getUTCFullYear();
  const m = local.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && local.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}

/** [TEMP] Oddiy foydalanuvchi paroli: 8–128 belgi (v2 admin bo'lmaganlar uchun qoida bermagan). */
export function validateUserPassword(pw: string): string | null {
  if (pw.length < 8) return 'PASSWORD_TOO_SHORT';
  if (pw.length > 128) return 'PASSWORD_TOO_LONG';
  return null;
}

/** Admin paroli: kamida 12, katta, kichik harf, raqam, maxsus belgi. */
export function validateAdminPassword(pw: string): string | null {
  if (pw.length < 12) return 'PASSWORD_TOO_SHORT';
  if (pw.length > 128) return 'PASSWORD_TOO_LONG';
  if (!/\p{Lu}/u.test(pw) || !/\p{Ll}/u.test(pw) || !/\d/.test(pw) || !/[^\p{L}\d]/u.test(pw)) {
    return 'PASSWORD_WEAK';
  }
  return null;
}
