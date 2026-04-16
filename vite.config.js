import { defineConfig } from 'vite'

export default defineConfig({
  // Project root is current directory; index.html is at root
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    open: true,
  },
})
