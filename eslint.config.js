import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'apps/client/assets/**',
      'src-tauri/**',
      'data/**',
      '.workbuddy/**',
      '*.md'
    ]
  },

  js.configs.recommended,

  {
    files: ['apps/server/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off'
    }
  },

  {
    files: ['apps/client/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        Swal: 'readonly',
        Fancybox: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      'no-console': 'off'
    }
  },

  {
    files: ['apps/client/shared/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    }
  }
];
