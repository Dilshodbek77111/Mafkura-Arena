/**
 * Ball va sertifikat qoidalari — sof funksiyalar (DB va I/O yo'q).
 * Barcha hisob-kitoblar BUTUN sonlarda bajariladi (float xatolari bo'lmasligi uchun).
 * Manba: docs/BUSINESS_RULES.md
 */

export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD';
export type CertTier = 'GOLD' | 'SILVER' | 'BRONZE';

export const DIFFICULTY_POINTS: Readonly<Record<Difficulty, number>> = {
  EASY: 10,
  MEDIUM: 20,
  HARD: 30,
};

export const PACK_SIZE = 30;
export const PACKS_PER_CYCLE = 10;
export const CYCLE_TOTAL_QUESTIONS = PACK_SIZE * PACKS_PER_CYCLE; // 300
export const POINT_MILESTONES = [3000, 7500] as const;
export const CHEAT_PENALTY_PERCENT = 40;
export const REPLAY_PERCENT = 10;

function assertNonNegInt(n: number, name: string): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${n}`);
  }
}

/** Butun sonli bo'lish, eng yaqin butunga (0.5 → yuqoriga). Faqat manfiy bo'lmagan sonlar uchun. */
function divRoundHalfUp(n: number, d: number): number {
  return Math.floor((2 * n + d) / (2 * d));
}

export function pointsForDifficulty(d: Difficulty): number {
  return DIFFICULTY_POINTS[d];
}

/** Eski to'plamni qayta ishlash (replay): asl ballning 10 foizi. 10→1, 20→2, 30→3. */
export function replayPoints(basePoints: number): number {
  assertNonNegInt(basePoints, 'basePoints');
  return divRoundHalfUp(basePoints * REPLAY_PERCENT, 100);
}

/** Anti-cheat jarimasi: to'plam oxiridagi jami ballning 40% i, eng yaqin butunga. 137 → 55. */
export function cheatPenalty(totalPoints: number): number {
  assertNonNegInt(totalPoints, 'totalPoints');
  return divRoundHalfUp(totalPoints * CHEAT_PENALTY_PERCENT, 100);
}

export function scoreAfterPenalty(totalPoints: number): number {
  return totalPoints - cheatPenalty(totalPoints);
}

/**
 * 10 kunlik sertifikat darajasi. Maxraj doim 300.
 * Taqqoslash butun sonlarda: correct/total*100 >= X  ⇔  correct*100 >= X*total.
 */
export function cycleTier(correct: number, total: number = CYCLE_TOTAL_QUESTIONS): CertTier | null {
  assertNonNegInt(correct, 'correct');
  assertNonNegInt(total, 'total');
  if (total === 0 || correct > total) throw new RangeError('invalid correct/total');
  const scaled = correct * 100;
  if (scaled >= 95 * total) return 'GOLD';
  if (scaled >= 80 * total) return 'SILVER';
  if (scaled >= 60 * total) return 'BRONZE';
  return null;
}

/** Faqat ko'rsatish uchun (2 xona). Qaror qabul qilishda cycleTier ishlatiladi. */
export function cycleAccuracyPercent(correct: number, total: number = CYCLE_TOTAL_QUESTIONS): number {
  assertNonNegInt(correct, 'correct');
  assertNonNegInt(total, 'total');
  if (total === 0 || correct > total) throw new RangeError('invalid correct/total');
  return Math.round((correct * 10000) / total) / 100;
}

/** Competition ranking: 1, 2, 2, 4. Natija kirish tartibida qaytariladi. */
export function competitionRanks(scores: readonly number[]): number[] {
  const sorted = [...scores].sort((a, b) => b - a);
  const firstIndex = new Map<number, number>();
  sorted.forEach((s, i) => {
    if (!firstIndex.has(s)) firstIndex.set(s, i + 1);
  });
  return scores.map((s) => firstIndex.get(s) as number);
}

/** Umumiy ball sertifikati chegaralari: prev < m <= next bo'lgan barcha m. */
export function crossedMilestones(prevTotal: number, nextTotal: number): number[] {
  return POINT_MILESTONES.filter((m) => prevTotal < m && nextTotal >= m);
}
