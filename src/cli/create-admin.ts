import { hashPassword } from '../auth/crypto';
import { normalizeEmail, validateAdminPassword, isValidEmail } from '../auth/validation';
import { createDb } from '../db/db';

/** Birinchi Head Admin yaratish: ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FIRST_NAME, ADMIN_LAST_NAME, [ADMIN_ROLE=HEAD_ADMIN] (muhit o'zgaruvchilari — parol buyruq qatorida/tarixda qolmasligi uchun). */
(async () => {
  const e = process.env;
  const email = normalizeEmail(e.ADMIN_EMAIL ?? '');
  if (!isValidEmail(email)) throw new Error('ADMIN_EMAIL invalid');
  const pwErr = validateAdminPassword(e.ADMIN_PASSWORD ?? '');
  if (pwErr) throw new Error(`ADMIN_PASSWORD rejected: ${pwErr}`);
  const role = e.ADMIN_ROLE === 'ADMIN' ? 'ADMIN' : 'HEAD_ADMIN';
  const db = createDb(e.DATABASE_URL ?? '');
  try {
    // Mavjud bo'lsa: rol va parol yangilanadi, hisob faollashtiriladi (parolni unutgan Head Admin uchun ham ishlaydi)
    const r = await db.query<{ created: boolean }>(
      `INSERT INTO admins (email, password_hash, first_name, last_name, role_id) VALUES ($1,$2,$3,$4,(SELECT id FROM roles WHERE key=$5))
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role_id = EXCLUDED.role_id, active = true
       RETURNING (xmax = 0) AS created`,
      [email, await hashPassword(e.ADMIN_PASSWORD!), e.ADMIN_FIRST_NAME ?? 'Admin', e.ADMIN_LAST_NAME ?? 'Admin', role]);
    console.log(`admin ${r.rows[0].created ? 'created' : 'updated'}: ${email} (${role})`);
  } finally { await db.end(); }
})().catch((err) => { console.error(String(err.message ?? err)); process.exit(1); });
