import { defineConfig } from 'vite';

// `base: './'` keeps every asset reference relative, so the built app works
// from a GitHub Pages project sub-path (https://<user>.github.io/<repo>/)
// as well as from a local file server.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
