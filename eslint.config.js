// ESLint flat config: type-checked rules over every TypeScript and JavaScript file.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', '.tools/', '.performance-results/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Three programs: src + smoke tests (built to dist/), the type-stripped
        // performance harness, and the k6 scripts.
        project: ['./tsconfig.json', './tsconfig.performance.json', './tsconfig.k6.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript already reports undefined names, including k6 globals.
      'no-undef': 'off',
      // Numbers read naturally in messages and URLs; everything else must be converted explicitly.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // `||` on strings deliberately treats an empty value (e.g. an unset env var) as missing.
      '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true } }],
      // node:test registers describe/it/test synchronously; their promises are tracked by the runner.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['describe', 'it', 'test', 'suite'] },
          ],
        },
      ],
    },
  },
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
