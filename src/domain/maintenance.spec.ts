import { assertWriteAllowed, ReadOnlyError } from './maintenance';

describe('read-only himoya', () => {
  it('01:00–10:59 da yozish rad etiladi va qayta ochilish vaqti 11:00', () => {
    try {
      assertWriteAllowed(new Date('2026-11-22T20:00:00Z')); // 01:00
      fail('tashlashi kerak edi');
    } catch (e) {
      expect(e).toBeInstanceOf(ReadOnlyError);
      expect((e as ReadOnlyError).reopensAt.toISOString()).toBe('2026-11-23T06:00:00.000Z');
    }
  });
  it('faol vaqtda ruxsat', () => {
    expect(() => assertWriteAllowed(new Date('2026-11-22T06:00:00Z'))).not.toThrow(); // 11:00
    expect(() => assertWriteAllowed(new Date('2026-11-22T19:59:59Z'))).not.toThrow(); // 00:59:59
  });
});
