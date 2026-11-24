import {
  competitionRanks, cheatPenalty, crossedMilestones, cycleAccuracyPercent,
  cycleTier, pointsForDifficulty, replayPoints, scoreAfterPenalty,
} from './scoring';

describe('ball qiymatlari', () => {
  it('qiyinlikdan ball', () => {
    expect(pointsForDifficulty('EASY')).toBe(10);
    expect(pointsForDifficulty('MEDIUM')).toBe(20);
    expect(pointsForDifficulty('HARD')).toBe(30);
  });
  it('replay 10%: 10→1, 20→2, 30→3', () => {
    expect(replayPoints(10)).toBe(1);
    expect(replayPoints(20)).toBe(2);
    expect(replayPoints(30)).toBe(3);
  });
  it('noto\'g\'ri kirishni rad etadi', () => {
    expect(() => replayPoints(-1)).toThrow(RangeError);
    expect(() => cheatPenalty(1.5)).toThrow(RangeError);
  });
});

describe('anti-cheat jarimasi (40%, eng yaqin butun)', () => {
  it('prompt namunasi: 137 → jarima 55, yakuniy 82', () => {
    expect(cheatPenalty(137)).toBe(55);
    expect(scoreAfterPenalty(137)).toBe(82);
  });
  it('100 → 40; 0 → 0', () => {
    expect(cheatPenalty(100)).toBe(40);
    expect(scoreAfterPenalty(100)).toBe(60);
    expect(cheatPenalty(0)).toBe(0);
  });
  it('yaxlitlash chegaralari', () => {
    expect(cheatPenalty(1)).toBe(0);  // 0.4
    expect(cheatPenalty(3)).toBe(1);  // 1.2
    expect(cheatPenalty(4)).toBe(2);  // 1.6
  });
});

describe('10 kunlik sertifikat darajasi (maxraj 300)', () => {
  it.each([
    [0, null], [179, null], [180, 'BRONZE'], [216, 'BRONZE'], [239, 'BRONZE'],
    [240, 'SILVER'], [284, 'SILVER'], [285, 'GOLD'], [300, 'GOLD'],
  ])('%i to\'g\'ri → %s', (correct, tier) => {
    expect(cycleTier(correct as number)).toBe(tier);
  });
  it('prompt namunasi: 216/300 = 72% (Bronza)', () => {
    expect(cycleAccuracyPercent(216)).toBe(72);
    expect(cycleTier(216)).toBe('BRONZE');
  });
  it('300 dan ko\'p bo\'lishi mumkin emas; foiz hisobida ham maxraj tekshiriladi', () => {
    expect(() => cycleTier(301)).toThrow(RangeError);
    expect(() => cycleAccuracyPercent(301)).toThrow(RangeError);
    expect(() => cycleAccuracyPercent(0, 0)).toThrow(RangeError);
  });
});

describe('competition ranking', () => {
  it('1, 2, 2, 4', () => {
    expect(competitionRanks([100, 90, 90, 80])).toEqual([1, 2, 2, 4]);
  });
  it('kirish tartibi saqlanadi', () => {
    expect(competitionRanks([80, 100, 90, 90])).toEqual([4, 1, 2, 2]);
  });
});

describe('umumiy ball sertifikatlari (3000 / 7500)', () => {
  it('chegarani kesib o\'tganda', () => {
    expect(crossedMilestones(2990, 3010)).toEqual([3000]);
    expect(crossedMilestones(2990, 8000)).toEqual([3000, 7500]);
    expect(crossedMilestones(3000, 3100)).toEqual([]);
    expect(crossedMilestones(2999, 3000)).toEqual([3000]);
  });
});
