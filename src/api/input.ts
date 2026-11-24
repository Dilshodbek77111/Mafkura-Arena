import { AuthError } from '../auth/auth.service';

type Body = Record<string, unknown> | undefined;
export const str = (b: Body, k: string, max = 500): string => {
  const v = b?.[k];
  if (typeof v !== 'string' || v.length > max) throw new AuthError('VALIDATION', { fields: { [k]: 'INVALID' } });
  return v;
};
export const optStr = (b: Body, k: string, max = 500): string | undefined => (b?.[k] === undefined ? undefined : str(b, k, max));
export const posInt = (v: string, name = 'id'): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AuthError('VALIDATION', { fields: { [name]: 'INVALID' } });
  return n;
};
