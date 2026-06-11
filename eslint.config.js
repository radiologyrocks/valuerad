// Flat ESLint config covering the Vite frontend (src/) and the Express
// backend (server/). Plain JS by deliberate choice (see CLAUDE.md); this is
// the gate that keeps the codebase consistent once more than one author edits
// it. Kept lean — catch real errors (undefined vars, unused code, bad
// promises), not style (Prettier owns style).
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['dist/**', '**/node_modules/**', 'server/node_modules/**'] },

  // Frontend — browser globals + React hooks rules.
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Advisory perf/style hints from the compiler-aware ruleset — surfaced as
      // warnings, not gate-blocking errors, for accepted mount-fetch patterns.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
    },
  },

  // Backend — Node globals.
  {
    files: ['server/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
