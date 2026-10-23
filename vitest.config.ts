import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'glsl',
      transform(code, id) {
        if (/\.(glsl|vs|fs|vert|frag)$/.test(id)) {
          return {
            code: `export default ${JSON.stringify(code)}`,
            map: null,
          };
        }
      },
    },
  ],
  resolve: {
    dedupe: ['three'],
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@threnic/lyrics': path.resolve(__dirname, './packages/lyrics/src/index.ts'),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: './test/setup.ts',
    css: false, // Disable CSS processing for speed
    pool: 'threads', // Use threads (default) but explicit
    exclude: ['**/node_modules/**', '**/dist/**', '**/test/e2e/**', 'src/test/**', '**/.claude/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*'],
      exclude: [
        'src/test/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.spec.ts',
        '**/*.d.ts',
        '**/*.md',
        '**/index.ts', // Exclude barrel files from coverage
      ],
    },
  },
});
