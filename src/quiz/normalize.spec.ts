import { answersMatch, normalizeAnswer } from './normalize';

describe('javobni normallashtirish', () => {
  it('registr, bo\'shliq va tinish belgilari', () => {
    expect(normalizeAnswer('  TOSHKENT!!  ')).toBe('toshkent');
    expect(normalizeAnswer('Amir   Temur.')).toBe('amir temur');
    expect(normalizeAnswer('1991-yil')).toBe('1991 yil');
  });
  it('apostrof variantlari va kirill/lotin bir xil natija beradi', () => {
    const forms = ["O'zbekiston", 'Oʻzbekiston', 'O‘ZBEKISTON', 'O’zbekiston', 'O`zbekiston', 'Ўзбекистон', 'ўзбекистон!'];
    const set = new Set(forms.map(normalizeAnswer));
    expect(set.size).toBe(1);
    expect([...set][0]).toBe('o\u02BBzbekiston');
  });
  it('g\' harfi ajratiladi, tutuq tushiriladi', () => {
    expect(normalizeAnswer("g'ozal")).toBe(normalizeAnswer('ғозал'));
    expect(normalizeAnswer("g'ozal")).not.toBe(normalizeAnswer('gozal'));
    expect(normalizeAnswer('ma’lumot')).toBe(normalizeAnswer("ma'lumot"));
    expect(normalizeAnswer('маълумот')).toBe(normalizeAnswer('malumot'));
  });
  it('kirill: ch, sh, ya, yu', () => {
    expect(normalizeAnswer('ТОШКЕНТ')).toBe('toshkent');
    expect(normalizeAnswer('Чимкент')).toBe('chimkent');
    expect(normalizeAnswer('Яшнабод')).toBe('yashnabod');
  });
  it('answersMatch: asosiy javob yoki variant; bo\'sh javob hech qachon mos emas', () => {
    expect(answersMatch('toshkent', 'Toshkent', [])).toBe(true);
    expect(answersMatch('Tashkent', 'Toshkent', ['Tashkent'])).toBe(true);
    expect(answersMatch('Samarqand', 'Toshkent', ['Tashkent'])).toBe(false);
    expect(answersMatch('  ?! ', '', [])).toBe(false);
  });
});
