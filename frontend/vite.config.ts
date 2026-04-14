import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';
import path from 'path';

// Get git commit SHA for version stamp
const getGitSha = () => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
  ],
  resolve: {
    alias: {
      // Ensure pipeline/ files resolve react from frontend node_modules
      react: path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
    },
  },
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __GIT_SHA__: JSON.stringify(getGitSha()),
    __APP_VERSION__: JSON.stringify('0.2.0'),
  },
  build: {
    // Sandpack + CodeMirror are lazy-loaded vendor chunks; suppress warnings for them
    chunkSizeWarningLimit: 550,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // React core
          if (id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/react/') ||
              id.includes('node_modules/react-router-dom/') ||
              id.includes('node_modules/react-router/') ||
              id.includes('node_modules/@remix-run/')) {
            return 'vendor-react';
          }
          // Sandpack (code preview) — lazy-loaded via PreviewPanel
          if (id.includes('node_modules/@codesandbox/')) {
            return 'vendor-sandpack';
          }
          // Framer Motion — used by LandingPage + animations
          if (id.includes('node_modules/framer-motion/') ||
              id.includes('node_modules/motion/')) {
            return 'vendor-ui';
          }
          // CodeMirror — used by CodeEditor (lazy)
          if (id.includes('node_modules/@codemirror/') ||
              id.includes('node_modules/@lezer/')) {
            return 'vendor-codemirror';
          }
        },
      },
    },
  },
  server: {
    host: process.env.VITE_DEV_HOST ?? '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: (() => {
      const target = process.env.VITE_PROXY_TARGET ?? 'http://localhost:3000';
      return {
        '/api': { target, changeOrigin: true, timeout: 0 },
        '/auth/oauth': { target, changeOrigin: true },
        '/auth/me': { target, changeOrigin: true },
        '/auth/logout': { target, changeOrigin: true },
        '/auth/signup': { target, changeOrigin: true },
        '/auth/login': { target, changeOrigin: true },
        '/auth/verify-email': { target, changeOrigin: true },
        '/auth/resend-code': { target, changeOrigin: true },
        '/auth/update-preferences': { target, changeOrigin: true },
        '/auth/profile': { target, changeOrigin: true },
        '/auth/password': { target, changeOrigin: true },
        '^/auth/invite(?:$|/(?:validate|accept)$)': {
          target,
          changeOrigin: true,
        },
      };
    })(),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
    // Define test-specific environment variables for import.meta.env
    env: {
      VITE_AGENTS_ENABLED: 'true',
      VITE_MOTION_ENABLED: 'true',
      VITE_CURSOR_GLOW_ENABLED: 'false',
      VITE_ENABLE_DEV_LOGIN: 'true',
      VITE_API_URL: 'http://localhost:3000',
      VITE_DEFAULT_LOCALE: 'en',
      VITE_BRAND_NAME: 'AKIS',
    },
  },
});
