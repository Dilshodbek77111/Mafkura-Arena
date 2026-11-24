/**
 * Platforma vaqti: Asia/Tashkent (UTC+5, 1991-yildan beri DST yo'q).
 * Faol vaqt 11:00–01:00; 01:00–11:00 read-only. Hamma vaqt bazada UTC.
 */
export const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Toshkent bo'yicha soat (0–23). */
export function tashkentHour(d: Date): number {
  return new Date(d.getTime() + TASHKENT_OFFSET_MS).getUTCHours();
}

/** Faol: 11:00–23:59 va 00:00–00:59. Read-only: 01:00–10:59. */
export function isActiveWindow(d: Date): boolean {
  const h = tashkentHour(d);
  return h >= 11 || h === 0;
}

/** Shu paytdan boshlab sayt faol bo'ladigan eng yaqin vaqt (faol bo'lsa — o'sha vaqtning o'zi). */
export function nextActiveAt(d: Date): Date {
  if (isActiveWindow(d)) return d;
  const local = d.getTime() + TASHKENT_OFFSET_MS;
  const dayStartLocal = Math.floor(local / DAY) * DAY;
  return new Date(dayStartLocal + 11 * HOUR - TASHKENT_OFFSET_MS);
}

/** [from, to] oralig'idagi FAOL vaqt soniyalari (hujjat tekshiruvining 4 soatlik muddati uchun). */
export function activeSecondsBetween(from: Date, to: Date): number {
  const start = from.getTime();
  const end = to.getTime();
  if (end <= start) return 0;
  let total = 0;
  let dayStart = Math.floor((start + TASHKENT_OFFSET_MS) / DAY) * DAY - TASHKENT_OFFSET_MS;
  for (; dayStart < end; dayStart += DAY) {
    const windows: Array<[number, number]> = [
      [dayStart, dayStart + 1 * HOUR],
      [dayStart + 11 * HOUR, dayStart + 24 * HOUR],
    ];
    for (const [ws, we] of windows) {
      const s = Math.max(ws, start);
      const e = Math.min(we, end);
      if (e > s) total += e - s;
    }
  }
  return Math.round(total / 1000);
}
