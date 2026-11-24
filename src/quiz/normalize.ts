/**
 * Javobni solishtirish uchun normallashtirish: registr, bo'shliq, tinish belgilari,
 * kirill→lotin (o'zbek), apostrof variantlari. oʻ va gʻ alohida harf sifatida saqlanadi,
 * tutuq belgisi (ma’lumot) esa tushirib qoldiriladi.
 */
const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ь: '', ы: 'i', э: 'e', ю: 'yu', я: 'ya', ў: "o'", қ: 'q', ғ: "g'", ҳ: 'h',
};
const MARK = '\u02BB'; // oʻ, gʻ ichidagi belgi

export function normalizeAnswer(input: string): string {
  let s = input.normalize('NFKC').toLowerCase();
  s = Array.from(s).map((ch) => CYR[ch] ?? ch).join('');
  s = s.replace(/[\u02BB\u2018\u2019\u02BC\u0060\u00B4\u2032']/g, "'");
  s = s.replace(/([og])'/g, `$1${MARK}`).replace(/'/g, '');
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

export function answersMatch(given: string, correct: string, variants: readonly string[]): boolean {
  const g = normalizeAnswer(given);
  if (!g) return false;
  return [correct, ...variants].some((c) => normalizeAnswer(c) === g);
}
