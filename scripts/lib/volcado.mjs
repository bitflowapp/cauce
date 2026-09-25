// Volcado de datos de pg_dump (bloques COPY) y su adaptación a la base donde se
// restaura.
//
// Supabase actualiza Auth y Storage en la nube antes que la CLI: el volcado del
// proyecto real puede traer tablas o columnas que el stack local todavía no
// tiene (apareció con auth.mfa_recovery_code_sets). Los esquemas propios
// (public, private) salen de las migraciones del repo y tienen que coincidir
// exactos: cualquier diferencia es un problema. De los esquemas de la
// plataforma se omite lo que el destino no conoce y se informa qué y con
// cuántas filas; las tablas esenciales (cuentas y archivos) nunca se omiten.

export const OWN_SCHEMAS = ['public', 'private'];
export const ESSENTIAL = ['auth.users', 'auth.identities', 'storage.buckets', 'storage.objects'];

const COPY = /^COPY "([^"]+)"\."([^"]+)" \((.*)\) FROM stdin;$/;
const SETVAL = /^SELECT pg_catalog\.setval\('"([^"]+)"\."([^"]+)"'/;
const NULL = '\\N';

export const quoted = name => name.split('.').map(part => `"${part}"`).join('.');

// Sentencias sueltas y bloques COPY, en orden. En el formato de texto de COPY
// los tabuladores de un valor van escapados: cada fila se parte por '\t'.
export function parseDump(text) {
  const blocks = [];
  const lines = text.split('\n');
  let sql = [];
  const flush = () => { if (sql.length) blocks.push({ sql }); sql = []; };
  for (let i = 0; i < lines.length; i += 1) {
    const header = COPY.exec(lines[i]);
    if (!header) { sql.push(lines[i]); continue; }
    flush();
    const table = `${header[1]}.${header[2]}`;
    const rows = [];
    for (i += 1; i < lines.length && lines[i] !== '\\.'; i += 1) rows.push(lines[i]);
    if (i >= lines.length) throw new Error(`El volcado termina dentro del COPY de ${table}.`);
    blocks.push({ table, columns: header[3].split(', ').map(name => name.replace(/^"(.*)"$/, '$1')), rows });
  }
  flush();
  return blocks;
}

// target: { columns: Map<'esquema.tabla', Set<columna>>, sequences: Set<'esquema.secuencia'> }
export function adaptDump(blocks, target) {
  const problems = [];
  const omitted = [];
  const tables = [];
  const out = [];
  for (const block of blocks) {
    if (block.sql) {
      for (const line of block.sql) {
        const setval = SETVAL.exec(line);
        const sequence = setval && `${setval[1]}.${setval[2]}`;
        if (sequence && !target.sequences.has(sequence)) {
          if (OWN_SCHEMAS.includes(setval[1])) problems.push(`${sequence}: la secuencia no existe en el destino`);
          else omitted.push(`secuencia ${sequence}`);
          continue;
        }
        out.push(line);
      }
      continue;
    }
    const own = OWN_SCHEMAS.includes(block.table.split('.')[0]);
    const columns = target.columns.get(block.table);
    if (!columns) {
      if (own || ESSENTIAL.includes(block.table)) problems.push(`${block.table}: la tabla no existe en el destino`);
      else omitted.push(`${block.table} (${block.rows.length} filas)`);
      continue;
    }
    const missing = block.columns.filter(name => !columns.has(name));
    if (missing.length && own) {
      problems.push(`${block.table}: columnas que las migraciones no crean (${missing.join(', ')})`);
      continue;
    }
    let names = block.columns;
    let { rows } = block;
    if (missing.length) {
      const drop = new Set(missing.map(name => block.columns.indexOf(name)));
      const valued = missing.filter(name => rows.some(row => row.split('\t')[block.columns.indexOf(name)] !== NULL));
      names = names.filter((_, index) => !drop.has(index));
      rows = rows.map(row => row.split('\t').filter((_, index) => !drop.has(index)).join('\t'));
      omitted.push(`${block.table}: ${missing.join(', ')}${valued.length ? ` (con valores: ${valued.join(', ')})` : ''}`);
    }
    tables.push(block.table);
    out.push(`COPY ${quoted(block.table)} (${names.map(name => `"${name}"`).join(', ')}) FROM stdin;`, ...rows, '\\.');
  }
  return { sql: out.join('\n'), tables, problems, omitted };
}

// Esquema del origen contra el restaurado. Los privilegios de service_role los
// fija Supabase al crear el proyecto y cambiaron con el tiempo (los proyectos
// nuevos ya no le dan ALL sobre las tablas): las migraciones de CAUCE no los
// tocan, así que se cuentan aparte. Todo lo demás tiene que ser idéntico.
const PLATFORM_GRANT = /^(GRANT|REVOKE) .+ (TO|FROM) "service_role";$/;
const normalizeSchema = text => String(text).split('\n')
  .map(line => line.trimEnd())
  .filter(line => line && !line.startsWith('--') && !/^SET |^SELECT pg_catalog\.set_config|^RESET ALL/.test(line));

export function compareSchemas(sourceText, restoredText) {
  const a = normalizeSchema(sourceText);
  const b = normalizeSchema(restoredText);
  const setA = new Set(a);
  const setB = new Set(b);
  const onlySource = a.filter(line => !setB.has(line));
  const onlyRestored = b.filter(line => !setA.has(line));
  const platform = [...onlySource, ...onlyRestored].filter(line => PLATFORM_GRANT.test(line));
  return {
    platform,
    onlySource: onlySource.filter(line => !PLATFORM_GRANT.test(line)),
    onlyRestored: onlyRestored.filter(line => !PLATFORM_GRANT.test(line)),
  };
}
