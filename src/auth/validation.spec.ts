import { ageInYears, isValidName, normalizeUzPhone, parseBirthDate, validateAdminPassword, validateUserPassword } from './validation';

describe('telefon', () => {
  it.each([
    ['+998 90 123-45-67', '+998901234567'],
    ['998901234567', '+998901234567'],
    ['901234567', '+998901234567'],
    ['(90) 123 45 67', '+998901234567'],
  ])('%s → %s', (raw, out) => expect(normalizeUzPhone(raw)).toBe(out));
  it.each(['', '12345', '+79001234567', '+998012345678', 'abc901234567'])('%s rad etiladi', (raw) =>
    expect(normalizeUzPhone(raw)).toBeNull());
});

describe('tug\'ilgan sana va yosh (Toshkent sanasi)', () => {
  const now = new Date('2026-11-22T10:00:00Z'); // Toshkentda 22-noyabr
  it('aynan 16 yosh bugun — 16', () => expect(ageInYears(parseBirthDate('2010-11-22')!, now)).toBe(16));
  it('16 ga bir kun qolgan — 15', () => expect(ageInYears(parseBirthDate('2010-11-23')!, now)).toBe(15));
  it('Toshkent yarim tundan keyin (UTC 20:00 = 01:00 ertasi) yangi sana hisoblanadi', () => {
    const late = new Date('2026-11-22T20:00:00Z'); // Toshkentda 23-noyabr 01:00
    expect(ageInYears(parseBirthDate('2010-11-23')!, late)).toBe(16);
  });
  it('mavjud bo\'lmagan sana rad etiladi', () => {
    expect(parseBirthDate('2010-02-30')).toBeNull();
    expect(parseBirthDate('10-02-2010')).toBeNull();
  });
});

describe('ism', () => {
  it.each(['Jasur', 'Ўктам', 'Oʻktam', "Sa'dulla", 'Anna-Maria', 'Gulnora Karimova'])('%s to\'g\'ri', (n) =>
    expect(isValidName(n)).toBe(true));
  it.each(['', '  ', '12', '<script>', 'a'.repeat(61)])('%s noto\'g\'ri', (n) => expect(isValidName(n)).toBe(false));
});

describe('parollar', () => {
  it('oddiy foydalanuvchi: 8+', () => {
    expect(validateUserPassword('1234567')).toBe('PASSWORD_TOO_SHORT');
    expect(validateUserPassword('12345678')).toBeNull();
  });
  it('admin: 12+, katta, kichik, raqam, maxsus', () => {
    expect(validateAdminPassword('Abcdef1!')).toBe('PASSWORD_TOO_SHORT');
    expect(validateAdminPassword('abcdefghij1!')).toBe('PASSWORD_WEAK');
    expect(validateAdminPassword('ABCDEFGHIJ1!')).toBe('PASSWORD_WEAK');
    expect(validateAdminPassword('Abcdefghijk!')).toBe('PASSWORD_WEAK');
    expect(validateAdminPassword('Abcdefghij12')).toBe('PASSWORD_WEAK');
    expect(validateAdminPassword('Abcdefghi1!x')).toBeNull();
  });
});
