module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'test-results/**', 'playwright-report/**'] },
  { files: ['**/*.js', '**/*.cjs'], languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: Object.fromEntries(['require','module','__dirname','process','Buffer','console','fetch','AbortController','AbortSignal','URL','Response','structuredClone','setTimeout','clearTimeout'].map(n => [n, 'readonly'])) }, rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }], 'no-unreachable': 'error', 'no-constant-condition': 'error' } },
  { files: ['renderer/*.js'], languageOptions: { sourceType: 'module', globals: { document: 'readonly', window: 'readonly', confirm: 'readonly' } } }
];
