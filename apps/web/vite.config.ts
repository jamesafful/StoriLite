import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxy API and static vault files to the Fastify server
      '/api': 'http://localhost:8787',
      '/vault': 'http://localhost:8787'
    }
  }
})
