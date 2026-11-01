const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: './tests/ui', outputDir: process.env.LDP_TEST_PACKAGED ? 'test-results/packaged' : 'test-results/source', timeout: 60000, workers: 1, retries: process.env.CI ? 1 : 0, reporter: 'list', use: { trace: 'retain-on-failure' } });
