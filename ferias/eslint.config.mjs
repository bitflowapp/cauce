// Lint de CAUCE · Ferias: reglas recomendadas con el entorno real de cada carpeta.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'dist/**', '.local/**', 'evidence/**', 'supabase/**'] },
  js.configs.recommended,
  { files: ['js/**/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser } } },
  { files: ['service-worker.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.serviceworker } } },
  { files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.mjs'], languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node, ...globals.browser } } },
  { rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] } },
];
