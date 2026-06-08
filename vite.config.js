import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  base: '/',
  server: {
    // Proxy API calls to the backend during local dev so the embedded app
    // (served by Vite) can reach the billing/SMART routes on port 3001.
    proxy: {
      '/billing': 'http://localhost:3001',
      '/epic': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
    },
  },
})
