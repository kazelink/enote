import js from '@eslint/js';
import globals from 'globals';

// 目标不是统一代码风格（项目本来就没格式化约定），而是抓“语法合法、运行时报错”这一类问题。
// 典型案例：scheduled.js 里调了 maintenanceTask() 却忘了 import，node --check 通过，
// 直到定时任务跑起来才 ReferenceError。
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
    files: ['apps/server/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.mjs'],
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
        // 通过 <script> 加载的第三方库，全局可用
        Swal: 'readonly',
        Fancybox: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 清洗控制字符用的 \x00-\x1f 是有意的
      'no-control-regex': 'off',
      'no-console': 'off'
    }
  },

  // shared/ 同时被浏览器和 Node 引用，两套全局都要认。
  {
    files: ['apps/client/shared/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    }
  }
];
