import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export class Db {
  constructor(public readonly pool: Pool) {}
  query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }
  /** Tranzaksiya: xato bo'lsa ROLLBACK, aks holda COMMIT. */
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  end(): Promise<void> { return this.pool.end(); }
}

export const createDb = (connectionString: string): Db => new Db(new Pool({ connectionString, max: 10 }));

/** pg unique_violation (23505) → constraint nomi, aks holda null. */
export function uniqueViolation(e: unknown): string | null {
  const err = e as { code?: string; constraint?: string };
  return err?.code === '23505' ? err.constraint ?? '' : null;
}
