import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptDump, compareSchemas, parseDump } from '../scripts/lib/volcado.mjs';

// Un volcado como el de `supabase db dump --data-only --use-copy`.
const DUMP = [
  'SET session_replication_role = replica;',
  '',
  'COPY "auth"."users" ("instance_id", "id", "email", "is_hosted_only") FROM stdin;',
  '0\tu1\ta@example.com\tt',
  '0\tu2\tb@example.com\t\\N',
  '\\.',
  '',
  'COPY "auth"."mfa_recovery_code_sets" ("id", "user_id") FROM stdin;',
  '\\.',
  '',
  'COPY "auth"."hosted_only_audit" ("id") FROM stdin;',
  'x1',
  'x2',
  '\\.',
  '',
  'COPY "public"."orders" ("id", "total_ars") FROM stdin;',
  'o1\t3000',
  '\\.',
  '',
  'SELECT pg_catalog.setval(\'"auth"."refresh_tokens_id_seq"\', 12, true);',
  'SELECT pg_catalog.setval(\'"auth"."hosted_only_seq"\', 1, false);',
  '',
  'RESET ALL;',
  '',
].join('\n');

const localStack = () => ({
  columns: new Map([
    ['auth.users', new Set(['instance_id', 'id', 'email'])],
    ['public.orders', new Set(['id', 'total_ars', 'status'])],
  ]),
  sequences: new Set(['auth.refresh_tokens_id_seq']),
});

test('lee sentencias y bloques COPY en orden', () => {
  const blocks = parseDump(DUMP);
  const copies = blocks.filter(block => block.table);
  assert.deepEqual(copies.map(block => block.table),
    ['auth.users', 'auth.mfa_recovery_code_sets', 'auth.hosted_only_audit', 'public.orders']);
  assert.deepEqual(copies[0].columns, ['instance_id', 'id', 'email', 'is_hosted_only']);
  assert.equal(copies[0].rows.length, 2);
  assert.equal(copies[1].rows.length, 0);
});

test('un COPY sin terminar es un error, no un volcado a medias', () => {
  assert.throws(() => parseDump('COPY "public"."orders" ("id") FROM stdin;\no1\n'), /termina dentro del COPY/);
});

test('omite lo que la plataforma agregó y el stack local no tiene, y lo informa', () => {
  const adapted = adaptDump(parseDump(DUMP), localStack());
  assert.deepEqual(adapted.problems, []);
  assert.deepEqual(adapted.tables, ['auth.users', 'public.orders']);
  assert.ok(adapted.omitted.includes('auth.mfa_recovery_code_sets (0 filas)'));
  assert.ok(adapted.omitted.includes('auth.hosted_only_audit (2 filas)'));
  assert.ok(adapted.omitted.includes('auth.users: is_hosted_only (con valores: is_hosted_only)'));
  assert.ok(adapted.omitted.includes('secuencia auth.hosted_only_seq'));
  // La columna se saca del encabezado y del mismo lugar de cada fila.
  assert.match(adapted.sql, /^COPY "auth"\."users" \("instance_id", "id", "email"\) FROM stdin;\n0\tu1\ta@example\.com\n0\tu2\tb@example\.com\n\\\.$/m);
  assert.match(adapted.sql, /setval\('"auth"\."refresh_tokens_id_seq"', 12, true\)/);
  assert.doesNotMatch(adapted.sql, /hosted_only_seq|mfa_recovery_code_sets|hosted_only_audit/);
  assert.match(adapted.sql, /^RESET ALL;$/m);
});

test('en los esquemas propios cualquier diferencia es un problema', () => {
  const target = localStack();
  target.columns.set('public.orders', new Set(['id']));
  const adapted = adaptDump(parseDump(DUMP), target);
  assert.deepEqual(adapted.problems, ['public.orders: columnas que las migraciones no crean (total_ars)']);
  target.columns.delete('public.orders');
  assert.deepEqual(adaptDump(parseDump(DUMP), target).problems, ['public.orders: la tabla no existe en el destino']);
});

test('las cuentas nunca se omiten aunque sean de la plataforma', () => {
  const target = localStack();
  target.columns.delete('auth.users');
  assert.deepEqual(adaptDump(parseDump(DUMP), target).problems, ['auth.users: la tabla no existe en el destino']);
});

test('sin diferencias, el volcado queda igual', () => {
  const same = [
    'SET session_replication_role = replica;',
    'COPY "public"."orders" ("id", "total_ars") FROM stdin;',
    'o1\t3000',
    '\\.',
    'RESET ALL;',
  ].join('\n');
  const adapted = adaptDump(parseDump(same), localStack());
  assert.equal(adapted.sql, same);
  assert.deepEqual(adapted.omitted, []);
});

// Lo que mostró el backup real (run 36076920287): el proyecto es anterior al
// cambio de privilegios por defecto de service_role.
test('los privilegios de service_role se cuentan aparte; el resto del esquema tiene que coincidir', () => {
  const source = [
    '-- volcado del origen',
    'SET statement_timeout = 0;',
    'CREATE TABLE "public"."trips" ("id" "uuid" NOT NULL);',
    'GRANT ALL ON TABLE "public"."trips" TO "service_role";',
    'GRANT SELECT ON TABLE "public"."trips" TO "authenticated";',
  ].join('\n');
  const restored = [
    'CREATE TABLE "public"."trips" ("id" "uuid" NOT NULL);',
    'GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."trips" TO "service_role";',
    'GRANT SELECT ON TABLE "public"."trips" TO "authenticated";',
    'RESET ALL;',
  ].join('\n');
  const same = compareSchemas(source, restored);
  assert.equal(same.platform.length, 2);
  assert.deepEqual([same.onlySource, same.onlyRestored], [[], []]);

  // Un privilegio de más para las visitas sí es una diferencia real.
  const drift = compareSchemas(`${source}\nGRANT ALL ON TABLE "public"."trips" TO "anon";`, restored);
  assert.deepEqual(drift.onlySource, ['GRANT ALL ON TABLE "public"."trips" TO "anon";']);
  // Y una columna cambiada a mano también.
  const column = compareSchemas(source.replace('"id" "uuid" NOT NULL', '"id" "uuid"'), restored);
  assert.equal(column.onlySource.length, 1);
  assert.equal(column.onlyRestored.length, 1);
});
