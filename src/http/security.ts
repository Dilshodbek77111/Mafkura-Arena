import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* e'tiborsiz */ } }
  }
  return out;
}

export function cookie(name: string, value: string, o: { httpOnly: boolean; secure: boolean; maxAgeSec?: number }): string {
  return [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax', o.httpOnly ? 'HttpOnly' : '', o.secure ? 'Secure' : '',
    o.maxAgeSec !== undefined ? `Max-Age=${o.maxAgeSec}` : ''].filter(Boolean).join('; ');
}

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** CSRF: double-submit cookie + Origin tekshiruvi. Har so'rovda csrf cookie bo'lmasa beriladi. */
export function securityMiddleware(cfg: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (cfg.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    const cookies = parseCookies(req.headers.cookie);
    let token = cookies.csrf;
    if (!token) {
      token = randomBytes(24).toString('base64url');
      res.append('Set-Cookie', cookie('csrf', token, { httpOnly: false, secure: cfg.secureCookies, maxAgeSec: 30 * 24 * 3600 }));
    }
    (req as Request & { csrfToken?: string }).csrfToken = token;

    if (MUTATING.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && !cfg.corsOrigins.includes(origin)) return deny(res);
      const sent = req.headers['x-csrf-token'];
      if (!cookies.csrf || typeof sent !== 'string' || !safeEq(sent, cookies.csrf)) return deny(res);
    }
    next();
  };
}
const deny = (res: Response) => { res.status(403).json({ error: { code: 'CSRF_INVALID' } }); };
