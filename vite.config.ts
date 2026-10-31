import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// base './' so the build works under a GitHub Pages subpath.
export default defineConfig({
  base: './',
  plugins: [svelte()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
