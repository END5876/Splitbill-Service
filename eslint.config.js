'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'data/**', 'coverage/**', 'layout-previews/**', 'types/**'] },
  js.configs.recommended,
  {
    // 伺服器端、測試、瀏覽器測試
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // UI 文字裡刻意用全形空白對齊
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipComments: true }],
    },
  },
  {
    // 網頁：index.html 依序載入的一般 script，彼此用全域函式／變數溝通（不是 ES module），
    // ESLint 一次只看一個檔，看不到別的檔定義的名稱：不檢查未定義／未使用，其他規則照常
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    rules: { 'no-undef': 'off', 'no-unused-vars': 'off', 'no-redeclare': 'off' },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    // 瀏覽器測試裡 page.evaluate(() => …) 的函式在瀏覽器執行
    files: ['e2e/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
