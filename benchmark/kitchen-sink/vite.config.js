import { defineConfig } from 'vite'
import inspect from 'vite-plugin-inspect'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [inspect({ build: true }), react()],
})
