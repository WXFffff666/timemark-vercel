// ESLint 9 flat config — repo-wide, deliberately NOT type-aware (the CI gate must stay fast).
// Scope: **/*.{ts,tsx}. Ignores built artifacts and the Vercel bundle entry.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: ['**/dist/**', 'api/handler.cjs', '.omo/**'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // Unused vars/args are a hard error per the Wave 0 gate; `_` prefix marks intentional non-use.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Pre-existing `any` usage is a warning, not a gate blocker (count recorded in .omo/evidence).
      '@typescript-eslint/no-explicit-any': 'warn',
      // shadcn/Radix UI primitives intentionally declare `interface X extends Y {}`.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
    },
  },
  {
    // react-hooks / react-refresh only make sense for the React app; backend has non-React `use*` APIs.
    files: ['frontend/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Vite fast-refresh guard; informational only (pre-existing violations are recorded, not fixed here).
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
);
