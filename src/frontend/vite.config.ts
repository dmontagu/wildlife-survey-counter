import { execSync } from 'node:child_process'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'

const backendUrl = process.env.VITE_BACKEND_URL || 'http://localhost:8100'

function buildCommitHash(): string {
  if (process.env.VITE_APP_COMMIT_HASH) {
    return process.env.VITE_APP_COMMIT_HASH
  }

  try {
    return execSync('git rev-parse --short=12 HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

const commitHash = buildCommitHash()
const buildTimestamp = new Date().toISOString()

export default defineConfig({
  base: process.env.VITE_BASE_PATH || './',
  define: {
    __APP_COMMIT_HASH__: JSON.stringify(commitHash),
    __APP_BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    proxy: {
      '/api': backendUrl,
      '/samples': backendUrl,
      '/uploads': backendUrl,
    },
  },
})
