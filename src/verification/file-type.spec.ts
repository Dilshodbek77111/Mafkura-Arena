import { sniffMime } from './file-type';

const b = (...x: number[]) => Uint8Array.from(x);
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

describe('fayl turini aniqlash (magic bytes)', () => {
  it('JPEG, PNG, WebP, PDF', () => {
    expect(sniffMime(b(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMime(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(sniffMime(Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')]))).toBe('image/webp');
    expect(sniffMime(ascii('%PDF-1.7'))).toBe('application/pdf');
  });
  it('boshqa fayllar (exe, html, bo\'sh) rad etiladi', () => {
    expect(sniffMime(ascii('MZ\x90\x00'))).toBeNull();
    expect(sniffMime(ascii('<html><script>'))).toBeNull();
    expect(sniffMime(new Uint8Array())).toBeNull();
  });
});
