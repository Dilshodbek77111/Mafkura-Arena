import { createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DocStorage } from '../verification/ports';

const KEY_RE = /^documents\/\d+\/[0-9a-f]{48}$/;

/**
 * Bitta serverli (VPS) joylashtirish uchun private disk saqlash. Fayllar ommaviy papkadan tashqarida, 0600 huquq bilan.
 * Ko'p serverli yoki bulutli joylashtirishda S3-mos adapter bilan almashtiriladi (DocStorage porti bir xil).
 */
export class LocalFsStorage implements DocStorage {
  constructor(private readonly dir: string, private readonly secret: string, private readonly baseUrl: string, private readonly now: () => Date = () => new Date()) {}

  private path(key: string): string {
    if (!KEY_RE.test(key)) throw new Error('invalid storage key');
    const p = resolve(join(this.dir, key));
    if (!p.startsWith(resolve(this.dir) + '/')) throw new Error('path escape');
    return p;
  }
  private sign(key: string, exp: number): string { return createHmac('sha256', this.secret).update(`${key}.${exp}`).digest('hex'); }

  async put(key: string, data: Uint8Array): Promise<void> {
    const p = this.path(key);
    await fs.mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await fs.writeFile(p, data, { mode: 0o600, flag: 'wx' });
  }
  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    this.path(key);
    const exp = Math.floor(this.now().getTime() / 1000) + ttlSeconds;
    return `${this.baseUrl}/api/v1/files/doc?k=${encodeURIComponent(key)}&e=${exp}&s=${this.sign(key, exp)}`;
  }
  /** Imzo va muddat to'g'ri bo'lsa faylni qaytaradi, aks holda null. */
  async readSigned(key: string, exp: number, sig: string): Promise<Buffer | null> {
    if (!KEY_RE.test(key) || !Number.isInteger(exp) || exp < Math.floor(this.now().getTime() / 1000)) return null;
    const a = Buffer.from(this.sign(key, exp)), b = Buffer.from(sig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return fs.readFile(this.path(key)).catch(() => null);
  }
  async delete(key: string): Promise<void> { await fs.rm(this.path(key), { force: true }); }
}
