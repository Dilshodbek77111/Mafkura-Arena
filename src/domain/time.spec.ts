import { activeSecondsBetween, isActiveWindow, nextActiveAt } from './time';

const utc = (s: string) => new Date(s);

describe('faol vaqt (Asia/Tashkent, UTC+5)', () => {
  it('11:00 faol, 10:59 read-only', () => {
    expect(isActiveWindow(utc('2026-11-22T06:00:00Z'))).toBe(true);  // 11:00
    expect(isActiveWindow(utc('2026-11-22T05:59:59Z'))).toBe(false); // 10:59:59
  });
  it('00:59 faol, 01:00 read-only', () => {
    expect(isActiveWindow(utc('2026-11-22T19:59:59Z'))).toBe(true);  // 00:59:59
    expect(isActiveWindow(utc('2026-11-22T20:00:00Z'))).toBe(false); // 01:00
  });
  it('nextActiveAt: 01:00 dan keyin ertasi 11:00', () => {
    expect(nextActiveAt(utc('2026-11-22T20:00:00Z')).toISOString()).toBe('2026-11-23T06:00:00.000Z');
    expect(nextActiveAt(utc('2026-11-22T23:30:00Z')).toISOString()).toBe('2026-11-23T06:00:00.000Z');
    expect(nextActiveAt(utc('2026-11-22T10:00:00Z')).toISOString()).toBe('2026-11-22T10:00:00.000Z');
  });
  it('activeSecondsBetween: faqat faol soatlar sanaladi', () => {
    // 10:00→13:00 Toshkent = faol 2 soat
    expect(activeSecondsBetween(utc('2026-11-22T05:00:00Z'), utc('2026-11-22T08:00:00Z'))).toBe(7200);
    // 00:30 → ertasi 12:00 = 30 daq + 1 soat
    expect(activeSecondsBetween(utc('2026-11-22T19:30:00Z'), utc('2026-11-23T07:00:00Z'))).toBe(5400);
    // butunlay read-only oyna
    expect(activeSecondsBetween(utc('2026-11-22T21:00:00Z'), utc('2026-11-23T04:00:00Z'))).toBe(0);
    expect(activeSecondsBetween(utc('2026-11-22T08:00:00Z'), utc('2026-11-22T05:00:00Z'))).toBe(0);
  });
});
