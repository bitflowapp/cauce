// Escaneo de secretos sobre TODOS los archivos versionados (git ls-files):
// claves de Supabase, JWT firmados, claves privadas, tokens de GitHub, Resend,
// Mercado Pago, AWS, Google y Slack, y contraseñas escritas en el código.
// Nunca imprime el valor encontrado: sólo archivo, línea y tipo.
//
//   node scripts/secretos.mjs          (sale con código 1 si encuentra algo)
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const PATTERNS = Object.freeze([
  ['JWT firmado', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}/],
  ['clave secreta de Supabase', /\bsb_secret_[A-Za-z0-9_-]{16,}/],
  ['token de acceso de Supabase', /\bsbp_[a-f0-9]{30,}/],
  ['clave privada', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED |DSA )?PRIVATE KEY-----/],
  ['token de GitHub', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['clave de Resend', /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/],
  ['credencial de Mercado Pago', /\bAPP_USR-[0-9A-Za-z-]{20,}|\bTEST-[0-9]{10,}-[0-9A-Za-z-]{20,}/],
  ['clave de AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['clave de Google', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['token de Slack', /\bxox[abprs]-[0-9A-Za-z-]{10,}/],
  ['URL con contraseña', /\b(?:postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s:@/]+:(?!\*\*\*|\$\{|<)[^\s@/]{6,}@/],
  // `env(...)` es una referencia (supabase/config.toml), no un valor.
  ['contraseña escrita', /\b(?:password|passwd|contrase(?:ñ|n)a|secret|api_?key)\s*[:=]\s*['"](?!env\()(?![^'"]*\$\{)[^'"\s]{12,}['"]/i],
]);
// Las pruebas crean cuentas sintéticas en stacks locales con contraseñas de
// prueba: en tests/ sólo se omite esa regla; todas las demás se aplican igual.
const FIXTURE_RULES = new Set(['contraseña escrita']);
// Archivos binarios o generados: no hay texto que revisar.
const SKIP = /\.(png|jpe?g|webp|gif|ico|woff2?|ttf|otf|pdf|zip|gz|gpg|mp4|mp3)$|^package-lock\.json$/i;
// Valores de ejemplo conocidos que no son secretos (documentación de terceros).
const ALLOWED = [/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.eyJzdWIiOiIxMjM0NTY3ODkwIi/];

const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const findings = [];
let scanned = 0;
for (const file of files) {
  if (SKIP.test(file)) continue;
  let text;
  try { text = await readFile(new URL(file, `file://${root}`), 'utf8'); } catch { continue; }
  scanned += 1;
  text.split('\n').forEach((line, index) => {
    for (const [kind, pattern] of PATTERNS) {
      if (file.startsWith('tests/') && FIXTURE_RULES.has(kind)) continue;
      const match = pattern.exec(line);
      if (match && !ALLOWED.some(allowed => allowed.test(match[0]))) findings.push(`${file}:${index + 1} · ${kind}`);
    }
  });
}
if (findings.length) {
  console.error(`SECRETOS · ${findings.length} hallazgos (no se muestran los valores):\n${findings.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`SECRETS_SCAN PASS · ${scanned} archivos versionados · 0 hallazgos`);
}
