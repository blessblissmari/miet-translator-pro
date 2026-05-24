import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Set BASE_PATH at build time (e.g. "/miet-translator/" for GitHub Pages).
const base = process.env.BASE_PATH ?? '/'

export default defineConfig({
  plugins: [react()],
  base,
  assetsInclude: ['**/*.pptx'],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
})
