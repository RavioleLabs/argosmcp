import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
export default defineConfig(({ mode }) => ({
  publicDir: false,
  plugins: [react(), ...(mode === 'cloudflare' ? cloudflare() : [])],
  build: { outDir: 'public', emptyOutDir: true },
}));
