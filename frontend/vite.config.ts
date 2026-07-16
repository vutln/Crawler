import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendUrl = env.BACKEND_URL || 'http://localhost:3000';

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 5173,
      // Fail loudly rather than silently sliding to 5174 when a stale dev server
      // is already up — the E2E suite targets 5173 by name.
      strictPort: true,
      proxy: {
        // This is what makes CORS a non-issue: the browser only ever talks to
        // :5173, so every request is same-origin. Nest sets a global 'api'
        // prefix, so no rewrite — /api/products -> :3000/api/products.
        '/api': { target: backendUrl, changeOrigin: true },
      },
    },
    build: { outDir: 'dist', sourcemap: true },
  };
});
