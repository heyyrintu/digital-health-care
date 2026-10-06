import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const APP_PACKAGES = ['@dhc/api', '@dhc/workers', '@dhc/web', '@dhc/mobile'];

/**
 * Shared flat config. Package boundaries (ADR 0001): shared packages never import
 * an app, and apps never import each other — they share code through packages/*.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.expo/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-restricted-imports': [
        'error',
        {
          paths: APP_PACKAGES.map((name) => ({
            name,
            message: 'Apps are not importable. Move shared code into packages/*.',
          })),
          patterns: [
            {
              group: ['**/apps/*', '**/apps/*/**'],
              message: 'Apps are not importable. Move shared code into packages/*.',
            },
          ],
        },
      ],
    },
  },
);
