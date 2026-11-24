import { Db } from '../db/db';
import { DIFFICULTY_POINTS, Difficulty } from '../domain/scoring';
import { AdminRole, requirePermission } from '../rbac/rbac';
import { AuditWriter } from '../verification/ports';
import { PACK_SIZE, QuizError } from './quiz.service';

export interface AdminActor { id: number; role: AdminRole }
export interface QuestionInput { text: string; correctAnswer: string; explanation: string; category: string; difficulty: Difficulty; variants: string[] }

const bad = (field: string): never => { throw new QuizError('VALIDATION', { fields: { [field]: 'INVALID' } }); };

export function parseQuestionInput(b: Record<string, unknown> | undefined, partial = false): Partial<QuestionInput> {
  const out: Partial<QuestionInput> = {};
  const s = (k: keyof QuestionInput, max: number, required: boolean) => {
    const v = b?.[k];
    if (v === undefined) { if (required && !partial) bad(k); return; }
    if (typeof v !== 'string' || v.trim().length === 0 && required || v.length > max) bad(k);
    (out as Record<string, unknown>)[k] = (v as string).trim();
  };
  s('text', 1000, true); s('correctAnswer', 300, true); s('explanation', 2000, false); s('category', 60, true);
  if (b?.difficulty !== undefined || !partial) {
    if (!['EASY', 'MEDIUM', 'HARD'].includes(b?.difficulty as string)) bad('difficulty');
    out.difficulty = b!.difficulty as Difficulty;
  }
  if (b?.variants !== undefined) {
    const v = b.variants;
    if (!Array.isArray(v) || v.length > 20 || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > 300)) bad('variants');
    out.variants = (v as string[]).map((x) => x.trim());
  } else if (!partial) out.variants = [];
  return out;
}

export class AdminQuizService {
  constructor(private readonly db: Db, private readonly audit: AuditWriter) {}

  async createQuestion(admin: AdminActor, input: QuestionInput) {
    requirePermission(admin.role, 'question.write');
    const id = await this.db.tx(async (c) => {
      const r = await c.query(
        'INSERT INTO questions (text, correct_answer, explanation, category, difficulty, points, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [input.text, input.correctAnswer, input.explanation ?? '', input.category, input.difficulty, DIFFICULTY_POINTS[input.difficulty], admin.id]);
      for (const v of input.variants) await c.query('INSERT INTO question_variants (question_id, text) VALUES ($1,$2)', [r.rows[0].id, v]);
      const id = r.rows[0].id as number;
      await this.audit.write({ adminId: admin.id, action: 'question.create', objectType: 'Question', objectId: String(id), newValue: input }, c);
      return id;
    });
    return { id };
  }

  /** Savolni tahrirlash. Boshlangan urinishlar snapshot ishlatadi, shuning uchun eski natijalar o'zgarmaydi. */
  async updateQuestion(admin: AdminActor, id: number, patch: Partial<QuestionInput> & { active?: boolean }) {
    requirePermission(admin.role, 'question.write');
    await this.db.tx(async (c) => {
      const cur = (await c.query('SELECT * FROM questions WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!cur) throw new QuizError('QUESTION_NOT_FOUND');
      const diff = patch.difficulty ?? cur.difficulty;
      await c.query(
        `UPDATE questions SET text=$2, correct_answer=$3, explanation=$4, category=$5, difficulty=$6, points=$7, active=$8, updated_at=now() WHERE id=$1`,
        [id, patch.text ?? cur.text, patch.correctAnswer ?? cur.correct_answer, patch.explanation ?? cur.explanation, patch.category ?? cur.category,
         diff, DIFFICULTY_POINTS[diff as Difficulty], patch.active ?? cur.active]);
      if (patch.variants) {
        await c.query('DELETE FROM question_variants WHERE question_id=$1', [id]);
        for (const v of patch.variants) await c.query('INSERT INTO question_variants (question_id, text) VALUES ($1,$2)', [id, v]);
      }
      await this.audit.write({ adminId: admin.id, action: 'question.update', objectType: 'Question', objectId: String(id),
        oldValue: { text: cur.text, correctAnswer: cur.correct_answer, difficulty: cur.difficulty, active: cur.active }, newValue: patch }, c);
    });
  }

  async deleteQuestion(admin: AdminActor, id: number) {
    requirePermission(admin.role, 'question.write');
    await this.db.tx(async (c) => {
      const r = await c.query('UPDATE questions SET active=false, deleted_at=now(), updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id', [id]);
      if (r.rowCount === 0) throw new QuizError('QUESTION_NOT_FOUND');
      await this.audit.write({ adminId: admin.id, action: 'question.delete', objectType: 'Question', objectId: String(id) }, c);
    });
  }

  async listQuestions(admin: AdminActor, limit = 100) {
    requirePermission(admin.role, 'question.write');
    const r = await this.db.query(
      `SELECT q.id, q.text, q.correct_answer, q.explanation, q.category, q.difficulty, q.points, q.active,
              COALESCE(array_agg(v.text) FILTER (WHERE v.id IS NOT NULL), '{}') AS variants
       FROM questions q LEFT JOIN question_variants v ON v.question_id = q.id WHERE q.deleted_at IS NULL
       GROUP BY q.id ORDER BY q.id DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => ({ id: x.id, text: x.text, correctAnswer: x.correct_answer, explanation: x.explanation, category: x.category,
      difficulty: x.difficulty, points: x.points, active: x.active, variants: x.variants }));
  }

  async createPack(admin: AdminActor, input: { title: string; packDate?: string; questionIds: number[] }) {
    requirePermission(admin.role, 'pack.write');
    const ids = input.questionIds;
    if (!Array.isArray(ids) || ids.length !== PACK_SIZE || new Set(ids).size !== PACK_SIZE || ids.some((i) => !Number.isInteger(i))) {
      throw new QuizError('PACK_INVALID', { reason: 'EXACTLY_30_DISTINCT_QUESTIONS' });
    }
    const id = await this.db.tx(async (c) => {
      const ok = (await c.query('SELECT count(*)::int AS n FROM questions WHERE id = ANY($1) AND active AND deleted_at IS NULL', [ids])).rows[0].n;
      if (ok !== PACK_SIZE) throw new QuizError('PACK_INVALID', { reason: 'QUESTION_MISSING_OR_INACTIVE' });
      const p = await c.query('INSERT INTO question_packs (title, pack_date, created_by) VALUES ($1,$2,$3) RETURNING id', [input.title, input.packDate ?? null, admin.id]);
      for (let i = 0; i < ids.length; i++) await c.query('INSERT INTO pack_questions (pack_id, question_id, position) VALUES ($1,$2,$3)', [p.rows[0].id, ids[i], i + 1]);
      const id = p.rows[0].id as number;
      await this.audit.write({ adminId: admin.id, action: 'pack.create', objectType: 'QuestionPack', objectId: String(id), newValue: input }, c);
      return id;
    });
    return { id };
  }

  async publishPack(admin: AdminActor, id: number) {
    requirePermission(admin.role, 'pack.write');
    await this.db.tx(async (c) => {
      const p = (await c.query('SELECT published FROM question_packs WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!p) throw new QuizError('PACK_NOT_FOUND');
      if (p.published) throw new QuizError('PACK_PUBLISHED');
      const n = (await c.query(
        'SELECT count(*)::int AS n FROM pack_questions pq JOIN questions q ON q.id=pq.question_id WHERE pq.pack_id=$1 AND q.active AND q.deleted_at IS NULL', [id])).rows[0].n;
      if (n !== PACK_SIZE) throw new QuizError('PACK_INVALID', { reason: 'QUESTION_MISSING_OR_INACTIVE' });
      await c.query('UPDATE question_packs SET published=true, published_at=now() WHERE id=$1', [id]);
      await this.audit.write({ adminId: admin.id, action: 'pack.publish', objectType: 'QuestionPack', objectId: String(id) }, c);
    });
  }

  async listPacks(admin: AdminActor) {
    requirePermission(admin.role, 'pack.write');
    const r = await this.db.query('SELECT id, title, pack_date, published, published_at FROM question_packs ORDER BY id DESC LIMIT 200');
    return r.rows.map((x) => ({ id: x.id, title: x.title, packDate: x.pack_date ? new Date(x.pack_date).toISOString().slice(0, 10) : null, published: x.published, publishedAt: x.published_at }));
  }
}
