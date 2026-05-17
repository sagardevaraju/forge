import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    // Several test files exercise the local SQLite file (chat_audit, pins,
    // book_totals, cohorts). Running them in parallel triggers SQLITE_BUSY.
    // Serial file execution adds a few seconds to a full run but is flake-free.
    fileParallelism: false,
  },
});
