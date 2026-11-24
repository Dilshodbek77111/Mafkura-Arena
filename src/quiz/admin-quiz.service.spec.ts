import { parseQuestionInput } from './admin-quiz.service';

describe('parseQuestionInput', () => {
  const valid = {
    text: 'Savol',
    correctAnswer: 'Toshkent',
    category: 'Geografiya',
    difficulty: 'EASY',
  };

  it('to‘g‘ri savol ma’lumotlarini qabul qiladi', () => {
    expect(parseQuestionInput(valid)).toMatchObject({
      text: 'Savol',
      correctAnswer: 'Toshkent',
      category: 'Geografiya',
      difficulty: 'EASY',
      variants: [],
    });
  });

  it('majburiy matn maydonlaridagi ortiqcha bo‘shliqlarni tozalaydi', () => {
    expect(parseQuestionInput({
      ...valid,
      text: '  Savol  ',
      correctAnswer: '  Toshkent  ',
      category: '  Geografiya  ',
    })).toMatchObject({
      text: 'Savol',
      correctAnswer: 'Toshkent',
      category: 'Geografiya',
    });
  });

  it('20 tagacha variantni qabul qiladi', () => {
    const variants = Array.from({ length: 20 }, (_, i) => `Javob ${i + 1}`);
    expect(parseQuestionInput({ ...valid, variants }).variants).toHaveLength(20);
  });

  it('21 ta variantni rad etadi', () => {
    const variants = Array.from({ length: 21 }, (_, i) => `Javob ${i + 1}`);
    expect(() => parseQuestionInput({ ...valid, variants })).toThrow();
  });

  it('bo‘sh variantni rad etadi', () => {
    expect(() => parseQuestionInput({ ...valid, variants: ['   '] })).toThrow();
  });

  it('301 belgilik variantni rad etadi', () => {
    expect(() => parseQuestionInput({ ...valid, variants: ['a'.repeat(301)] })).toThrow();
  });

  it('PATCH holatida yuborilmagan maydonlarni talab qilmaydi', () => {
    expect(parseQuestionInput({ text: 'Yangi savol' }, true)).toEqual({
      text: 'Yangi savol',
    });
  });

  it('PATCH holatida bo‘sh variants massivini qabul qiladi', () => {
    expect(parseQuestionInput({ variants: [] }, true)).toEqual({
      variants: [],
    });
  });
});
