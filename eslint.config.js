// ESLint flat config (owner: W10). `npm run lint` === `eslint .`
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '.probe-*',
      '.probe-*/**',
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'public/**',
      'tests/fixtures/*.json',
      'tests/fixtures/*.y4m',
      'tests/e2e/__screenshots__/**',
      '.vercel/**',
      // Any dot-directory (e.g. ad-hoc build checks like .w3-dist-check/) is never source.
      '**/.*/**',
      // Dev harness pages are per-worker visual sandboxes; they must typecheck (tsc includes src/**)
      // but are not held to app lint rules (lead-checklist B16).
      'src/**/__harness__/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2023 },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],
      // Contract §0: "no console noise". warn/error are allowed for genuine failures.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Heuristic rule (React Compiler era); legitimate 'refresh on mount' patterns trip it. Keep visible, not blocking.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    // Node-side: build scripts, configs, fixture generator, Playwright specs.
    files: ['scripts/**/*.mjs', 'tests/fixtures/**/*.mjs', '*.config.{ts,js}', 'tests/e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-console': 'off' },
  },
  {
    // Unit tests may log through vitest; keep them strict otherwise.
    files: ['tests/unit/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
);
