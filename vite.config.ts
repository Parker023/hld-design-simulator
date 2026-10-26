import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // React Flow + Recharts make one ~280 KB gzipped bundle; fine for a single-page tool.
  build: { chunkSizeWarningLimit: 1200 },
})
