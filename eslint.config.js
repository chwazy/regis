import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '.*/worktrees/**',
      '**/target/**',
      '**/node_modules/**',
      'sidecar/.build/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: [
      'scripts/**/*.mjs',
      'sidecar/**/*.ts',
      '*.config.{js,ts}',
      'apps/desktop/src-tauri/crates/*/tests/**/*.mjs',
      'tests/servers/**/*.mjs',
    ],
    languageOptions: { globals: globals.node },
  },
);
