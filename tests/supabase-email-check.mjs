// A single synthetic public signup probe. Never disables confirmation to pass.
import { adminClient, publicClient, requireSuccess } from './lib/supabase-real.mjs';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
const email = `cauce-qa-email-${randomUUID()}@example.com`;
const admin = adminClient();
const result = await publicClient().auth.signUp({ email, password: `Qa-${randomUUID()}-1`,
  options: { data: { display_name: 'Prueba Correo', phone: '' }, emailRedirectTo: 'http://127.0.0.1:4174/index.html' } });
const report = { at: new Date().toISOString(), project: 'ygqbcvxdrewcnzedfcyo',
  signupAccepted: !result.error, code: result.error?.code || null, status: result.error?.status || null,
  note: 'Acceptance does not demonstrate mailbox delivery. Synthetic example.com address.' };
// A failed SMTP send may still leave an unconfirmed account. Remove only this exact address.
const { users } = requireSuccess(await admin.auth.admin.listUsers({ page: 1, perPage: 1000 }));
const user = users.find(u => u.email === email);
if (user) requireSuccess(await admin.auth.admin.deleteUser(user.id));
await mkdir('evidence', { recursive: true });
await writeFile('evidence/supabase-email-check.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
