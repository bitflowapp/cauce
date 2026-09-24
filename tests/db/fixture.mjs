// Esquemas de plataforma que las migraciones esperan encontrar (auth, storage,
// publicación de Realtime), con la misma forma que usan las políticas. Sólo
// reemplazan lo que en Supabase provee la plataforma; las migraciones corren
// tal cual.
import { readFile, readdir } from 'node:fs/promises';

export const PLATFORM_SQL = `
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, email text, is_anonymous boolean not null default false,
  deleted_at timestamptz, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant execute on function auth.jwt() to anon, authenticated;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz not null default now());
create table storage.objects (id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id), name text not null, owner uuid,
  metadata jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (bucket_id, name));
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated;
grant select on storage.buckets to anon, authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;
create publication supabase_realtime;
-- Exercise old Supabase defaults too: migrations must revoke these grants.
alter default privileges in schema public grant all on tables to anon, authenticated;
`;

const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);

export async function migrationFiles() {
  return (await readdir(MIGRATIONS)).filter(name => name.endsWith('.sql')).sort();
}

export const versionOf = file => Number(file.split('_')[0]);

// Aplica las migraciones en orden. `until` deja afuera las versiones >= until,
// para reconstruir el esquema tal como estaba antes de una migración.
export async function applyMigrations(db, { until = Infinity, platform = true } = {}) {
  if (platform) await db.exec(PLATFORM_SQL);
  const applied = [];
  for (const file of await migrationFiles()) {
    if (versionOf(file) >= until) continue;
    await db.exec(await readFile(new URL(file, MIGRATIONS), 'utf8'));
    applied.push(file);
  }
  return applied;
}

export async function applyMigration(db, file) {
  await db.exec(await readFile(new URL(file, MIGRATIONS), 'utf8'));
}
