// ESLint flat config (ESLint 9+ / typescript-eslint 8).
// Replaces the legacy .eslintrc.json; rules, ignores and parser options are
// carried over unchanged.
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

// Flat config has no `--ext` flag, so the TypeScript-only scope that the
// `eslint src/ --ext .ts,.tsx` script used to provide lives here instead.
const files = ['**/*.ts', '**/*.tsx'];

export default [
  {
    // Formerly .eslintrc.json "ignorePatterns". tabs/ and functions/ keep
    // their own ESLint setups and are linted by separate CI jobs.
    ignores: ['lib/**', 'node_modules/**', 'tabs/**', 'functions/**'],
  },
  { ...js.configs.recommended, files },
  ...tseslint.configs['flat/recommended'].map((config) => ({
    ...config,
    files,
  })),
  {
    files,
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      'max-lines': [
        'error',
        { max: 1000, skipBlankLines: true, skipComments: true },
      ],
    },
  },
];
