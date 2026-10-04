'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  { rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }] } },
  {
    files: ['server/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node }
  },
  {
    // Browser tests pass functions into the page, so page names like `document` appear in them.
    files: ['tests/e2e/**/*.js'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } }
  },
  {
    files: ['extension/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser, chrome: 'readonly' } }
  },
  {
    files: ['extension/page-watcher.js', 'extension/drm-watcher.js'],
    languageOptions: { sourceType: 'script' }
  },
  {
    // The TV browser can be very old, so the TV page must stay ES5.
    files: ['tv/**/*.js'],
    languageOptions: { ecmaVersion: 5, sourceType: 'script', globals: globals.browser }
  }
];
