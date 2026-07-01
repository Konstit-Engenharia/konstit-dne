import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['typescript', 'unicorn', 'oxc', 'promise', 'import'],
  categories: {},
  rules: {},
  settings: {},
  env: {
    builtin: true,
  },
  globals: {},
  ignorePatterns: [
    '**/.cache/**',
    '**/.vscode/**',
    '**/bin/**',
    '**/cache/**',
    '**/data/**',
    '**/db/**',
    '**/docs/**',
    '**/node_modules/**',
    '**/sample/**',
    '**/*-lock.json',
    '**/*.input.ts',
    'dprint.json',
    'data/market.js',
  ],
});
