export type AllowedMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

/** Fayl turini deklaratsiyaga ishonmasdan, birinchi baytlardan aniqlaydi. */
export function sniffMime(b: Uint8Array): AllowedMime | null {
  const at = (i: number) => b[i];
  if (b.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => at(i) === v)) return 'image/png';
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (b.length >= 5 && String.fromCharCode(...b.slice(0, 5)) === '%PDF-') return 'application/pdf';
  return null;
}

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024; // [TEMP] 5 MB
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;   // [TEMP] 2 MB
