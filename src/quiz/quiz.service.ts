import { PoolClient } from 'pg';
import { Db } from '../db/db';
import { assertWriteAllowed } from '../domain/maintenance';
import { activeSecondsBetween, isActiveWindow } from '../domain/time';
import { answersMatch } from './normalize';

export type QuizErrorCode =
  | 'PACK_NOT_FOUND' | 'ATTEMPT_NOT_FOUND' | 'NO_OPEN_QUESTION' | 'QUESTION_OPEN' | 'QUESTION_NOT_FOUND'
  | 'PACK_INVALID' | 'PACK_PUBLISHED' | 'VALIDATION';
export class QuizError extends Error {
  constructor(public readonly code: QuizErrorCode, public readonly details?: Record<string, unknown>) { super(code); }
}

export const QUESTION_SECONDS = 60;
export const PACK_SIZE = 30;
const FINAL = ['CORRECT', 'WRONG', 'UNANSWERED'];

interface Snapshot { text: string; correctAnswer: string; variants: string[]; explanation: string; category: string; difficulty: string; points: number }
interface AnswerRow {
  id: number; position: number; status: string; snapshot: Snapshot; opened_at: Date | null; deadline_at: Date | null;
  submitted_text: string | null; awarded_points: number;
}

/** [opened, deadline] oralig'ining bir qismi read-only (01:00–11:00) vaqtga tushganmi. */
function crossesMaintenance(opened: Date, deadline: Date): boolean {
  return activeSecondsBetween(opened, deadline) < Math.round((deadline.getTime() - opened.getTime()) / 1000);
}

export class QuizService {
  constructor(private readonly db: Db, private readonly now: () => Date) {}

  async listPacks(userId: number) {
    const r = await this.db.query(
      `SELECT p.id, p.title, p.pack_date, a.id AS attempt_id, a.status AS attempt_status, a.raw_points,
              (SELECT count(*)::int FROM quiz_answers qa WHERE qa.attempt_id = a.id AND qa.status IN ('CORRECT','WRONG','UNANSWERED')) AS answered
       FROM question_packs p LEFT JOIN quiz_attempts a ON a.pack_id = p.id AND a.user_id = $1 AND a.kind = 'MAIN'
       WHERE p.published AND p.type = 'MAIN' ORDER BY p.pack_date DESC NULLS LAST, p.id DESC LIMIT 200`, [userId]);
    return r.rows.map((x) => ({
      id: x.id, title: x.title, packDate: x.pack_date ? new Date(x.pack_date).toISOString().slice(0, 10) : null, questionCount: PACK_SIZE,
      attempt: x.attempt_id ? { id: x.attempt_id, status: x.attempt_status, answered: x.answered } : null,
    }));
  }

  /** Asosiy urinishni boshlaydi yoki mavjudini davom ettiradi (qayta kirish yangi urinish yaratmaydi). */
  async start(userId: number, packId: number) {
    const now = this.now();
    assertWriteAllowed(now);
    const attemptId = await this.db.tx(async (c) => {
      const pack = (await c.query("SELECT id FROM question_packs WHERE id=$1 AND published AND type='MAIN'", [packId])).rows[0];
      if (!pack) throw new QuizError('PACK_NOT_FOUND');
      const ins = await c.query(
        `INSERT INTO quiz_attempts (user_id, pack_id, kind, main_lock_pack_id) VALUES ($1,$2,'MAIN',$2)
         ON CONFLICT ON CONSTRAINT quiz_attempts_main_once DO NOTHING RETURNING id`, [userId, packId]);
      if (ins.rowCount === 0) {
        return (await c.query("SELECT id FROM quiz_attempts WHERE user_id=$1 AND main_lock_pack_id=$2", [userId, packId])).rows[0].id as number;
      }
      const id = ins.rows[0].id as number;
      const qs = await c.query(
        `SELECT q.id, q.text, q.correct_answer, q.explanation, q.category, q.difficulty, q.points, pq.position,
                COALESCE(array_agg(v.text) FILTER (WHERE v.id IS NOT NULL), '{}') AS variants
         FROM pack_questions pq JOIN questions q ON q.id = pq.question_id LEFT JOIN question_variants v ON v.question_id = q.id
         WHERE pq.pack_id = $1 GROUP BY q.id, pq.position ORDER BY pq.position`, [packId]);
      if (qs.rowCount !== PACK_SIZE) throw new QuizError('PACK_INVALID', { count: qs.rowCount });
      for (const q of qs.rows) {
        const snap: Snapshot = { text: q.text, correctAnswer: q.correct_answer, variants: q.variants, explanation: q.explanation, category: q.category, difficulty: q.difficulty, points: q.points };
        const first = q.position === 1;
        await c.query(
          'INSERT INTO quiz_answers (attempt_id, position, question_id, snapshot, status, opened_at, deadline_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [id, q.position, q.id, JSON.stringify(snap), first ? 'OPEN' : 'PENDING', first ? now : null, first ? new Date(now.getTime() + QUESTION_SECONDS * 1000) : null]);
      }
      return id;
    });
    return this.state(userId, attemptId);
  }

  async state(userId: number, attemptId: number) {
    return this.db.tx(async (c) => {
      await this.lock(c, userId, attemptId);
      await this.settle(c, attemptId);
      return this.build(c, attemptId);
    });
  }

  async answer(userId: number, attemptId: number, text: string) {
    const given = text.trim();
    if (!given || given.length > 500) throw new QuizError('VALIDATION', { fields: { text: 'INVALID' } });
    const outcome = await this.db.tx(async (c) => {
      await this.lock(c, userId, attemptId);
      const now = this.now();
      assertWriteAllowed(now);
      await this.settle(c, attemptId);
      const open = (await c.query<AnswerRow>("SELECT * FROM quiz_answers WHERE attempt_id=$1 AND status='OPEN'", [attemptId])).rows[0];
      // Muddati o'tgan savolni settle() yakunlagan bo'lsa, tranzaksiyani commit qilamiz.
      // Aks holda throw tranzaksiyani rollback qilib, savolni OPEN holatida qoldirardi.
      if (!open) return { expiredOrAlreadyAnswered: true as const };
      const s = open.snapshot;
      const correct = answersMatch(given, s.correctAnswer, s.variants);
      const points = correct ? s.points : 0;
      await c.query('UPDATE quiz_answers SET status=$2, submitted_text=$3, answered_at=$4, awarded_points=$5 WHERE id=$1',
        [open.id, correct ? 'CORRECT' : 'WRONG', given, now, points]);
      if (points > 0) {
        const led = await c.query(
          `INSERT INTO score_ledger (user_id, amount, source, reason, ref_type, ref_id, idempotency_key)
           VALUES ($1,$2,'QUIZ_MAIN','Asosiy viktorina: to''g''ri javob','quiz_answer',$3,$4) ON CONFLICT (idempotency_key) DO NOTHING`,
          [userId, points, String(open.id), `quiz:main:${attemptId}:${open.position}`]);
        if (led.rowCount === 1) {
          await c.query(
            `INSERT INTO user_scores (user_id, total) VALUES ($1,$2)
             ON CONFLICT (user_id) DO UPDATE SET total = user_scores.total + $2, updated_at = now()`, [userId, points]);
        }
      }
      await this.finishIfDone(c, attemptId, now);
      return {
        expiredOrAlreadyAnswered: false as const,
        value: {
          result: { position: open.position, status: correct ? 'CORRECT' : 'WRONG', correctAnswer: s.correctAnswer, explanation: s.explanation, awardedPoints: points, submittedText: given },
          state: await this.build(c, attemptId),
        },
      };
    });
    if (outcome.expiredOrAlreadyAnswered) throw new QuizError('NO_OPEN_QUESTION');
    return outcome.value;
  }

  /** "Keyingi savol" tugmasi: faqat oldingi savol yakunlangandan keyin. */
  async next(userId: number, attemptId: number) {
    return this.db.tx(async (c) => {
      await this.lock(c, userId, attemptId);
      const now = this.now();
      assertWriteAllowed(now);
      await this.settle(c, attemptId);
      const open = (await c.query("SELECT 1 FROM quiz_answers WHERE attempt_id=$1 AND status='OPEN'", [attemptId])).rowCount;
      if (open) throw new QuizError('QUESTION_OPEN');
      const nx = (await c.query("SELECT id FROM quiz_answers WHERE attempt_id=$1 AND status='PENDING' ORDER BY position LIMIT 1", [attemptId])).rows[0];
      if (nx) {
        await c.query("UPDATE quiz_answers SET status='OPEN', opened_at=$2, deadline_at=$3 WHERE id=$1",
          [nx.id, now, new Date(now.getTime() + QUESTION_SECONDS * 1000)]);
      } else {
        await this.finishIfDone(c, attemptId, now);
      }
      return this.build(c, attemptId);
    });
  }

  // ───────── ichki ─────────
  private async lock(c: PoolClient, userId: number, attemptId: number): Promise<void> {
    const r = await c.query('SELECT id FROM quiz_attempts WHERE id=$1 AND user_id=$2 FOR UPDATE', [attemptId, userId]);
    if (r.rowCount === 0) throw new QuizError('ATTEMPT_NOT_FOUND');
  }

  /** Muddati o'tgan ochiq savolni hal qiladi: javobsiz yoki (01:00 tanaffusiga tushgan bo'lsa) yangi 60 soniya. */
  private async settle(c: PoolClient, attemptId: number): Promise<void> {
    const now = this.now();
    const open = (await c.query<AnswerRow>("SELECT * FROM quiz_answers WHERE attempt_id=$1 AND status='OPEN'", [attemptId])).rows[0];
    if (!open || now < open.deadline_at!) return;
    if (crossesMaintenance(open.opened_at!, open.deadline_at!)) {
      if (!isActiveWindow(now)) return; // tanaffus davom etmoqda: savol to'xtab turibdi
      await c.query('UPDATE quiz_answers SET opened_at=$2, deadline_at=$3 WHERE id=$1', [open.id, now, new Date(now.getTime() + QUESTION_SECONDS * 1000)]);
      return;
    }
    await c.query("UPDATE quiz_answers SET status='UNANSWERED', answered_at=$2, awarded_points=0 WHERE id=$1", [open.id, open.deadline_at]);
    await this.finishIfDone(c, attemptId, now);
  }

  private async finishIfDone(c: PoolClient, attemptId: number, now: Date): Promise<void> {
    const left = (await c.query("SELECT count(*)::int AS n FROM quiz_answers WHERE attempt_id=$1 AND status IN ('PENDING','OPEN')", [attemptId])).rows[0].n;
    if (left === 0) {
      await c.query(
        `UPDATE quiz_attempts SET status='FINISHED', finished_at=COALESCE(finished_at,$2),
                raw_points=(SELECT COALESCE(sum(awarded_points),0) FROM quiz_answers WHERE attempt_id=$1) WHERE id=$1 AND status<>'FINISHED'`, [attemptId, now]);
    }
  }

  private async build(c: PoolClient, attemptId: number) {
    const now = this.now();
    const a = (await c.query('SELECT id, pack_id, status, raw_points FROM quiz_attempts WHERE id=$1', [attemptId])).rows[0];
    const rows = (await c.query<AnswerRow>('SELECT * FROM quiz_answers WHERE attempt_id=$1 ORDER BY position', [attemptId])).rows;
    const finals = rows.filter((r) => FINAL.includes(r.status));
    const open = rows.find((r) => r.status === 'OPEN');
    const last = finals.length ? finals[finals.length - 1] : undefined;
    // Oxirgi yakunlangan savol natijasi: "Keyingi savol" bosilguncha ko'rsatiladi
    const showLast = last && !open;
    return {
      attemptId, packId: a.pack_id, status: a.status as string, total: rows.length, answered: finals.length,
      points: finals.reduce((s, r) => s + r.awarded_points, 0),
      paused: !!open && !isActiveWindow(now),
      current: open ? {
        position: open.position, text: open.snapshot.text, category: open.snapshot.category, difficulty: open.snapshot.difficulty,
        points: open.snapshot.points, remainingSeconds: Math.max(0, Math.ceil((open.deadline_at!.getTime() - now.getTime()) / 1000)),
      } : null,
      lastResult: showLast ? {
        position: last!.position, status: last!.status, submittedText: last!.submitted_text, correctAnswer: last!.snapshot.correctAnswer,
        explanation: last!.snapshot.explanation, awardedPoints: last!.awarded_points,
      } : null,
      canAdvance: !open && rows.some((r) => r.status === 'PENDING'),
    };
  }
}
