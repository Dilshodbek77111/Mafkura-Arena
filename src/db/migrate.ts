import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from './db';

const DIR = join(__dirname, '..', '..', 'migrations');

/** Qo'llanmagan migrationlarni tartib bilan, har birini alohida tranzaksiyada bajaradi. Qaytadan chaqirish xavfsiz. */
export async function migrate(db: Db, dir: string = DIR): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(727001)'); // parallel migratsiyadan himoya
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const f of files) {
      if (done.has(f)) continue;
      await c.query(readFileSync(join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
      applied.push(f);
    }
  });
  return applied;
}
