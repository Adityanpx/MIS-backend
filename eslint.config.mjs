import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.storage/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['**/db/pools', '**/db/pools.ts'],
          message: 'Only src/db/* may import the pools. Use withTenant/withAdmin/withSystem from src/db/tenant.' }],
      }],
    },
  },
  {
    files: ['src/db/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['scripts/**/*.ts', 'src/db/migrate.ts', 'src/db/reset.ts', 'src/db/seeds/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
