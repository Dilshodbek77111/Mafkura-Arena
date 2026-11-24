import { createDb } from './db';
import { migrate } from './migrate';

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createDb(url);
  const applied = await migrate(db);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
