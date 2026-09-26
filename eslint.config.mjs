// Lint de CAUCE: reglas recomendadas de ESLint, con los entornos reales de
// cada carpeta (navegador, service worker, Node para scripts y pruebas).
import js from '@eslint/js';
import globals from 'globals';

export default [
  // De supabase/ se revisan sólo las Edge Functions (JavaScript para Deno).
  { ignores: ['node_modules/**', 'dist/**', 'dist-production/**', '.local/**', 'supabase/functions/.local/**', 'evidence/**', 'supabase/*',
    '!supabase/functions', 'CAUCE-demo.html'] },
  js.configs.recommended,
  {
    files: ['js/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: ['service-worker.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.serviceworker } },
  },
  {
    // Edge Functions: APIs web estándar y Deno; nada del navegador ni de Node.
    files: ['supabase/functions/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module',
      globals: { ...globals.worker, Deno: 'readonly', EdgeRuntime: 'readonly' } },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
