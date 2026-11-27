import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Replaces apache-arrow's runtime `new Function(...)` switch generator in
 * `builder/valid.mjs` with a 100% CSP-compliant pure-JS Set closure so strict
 * Content-Security-Policy (without 'unsafe-eval') executes cleanly.
 */
function cspSafeApacheArrowPlugin(): Plugin {
  return {
    name: 'csp-safe-apache-arrow',
    enforce: 'pre',
    transform(_code, id) {
      const normalized = id.replace(/\\/g, '/');
      if (normalized.endsWith('apache-arrow/builder/valid.mjs')) {
        return {
          code: `export function createIsValidFunction(nullValues) {
  if (!nullValues || nullValues.length <= 0) {
    return function isValid() { return true; };
  }
  const hasNaN = nullValues.some((v) => v !== v);
  const nullSet = new Set(nullValues.filter((v) => v === v));
  return function isValid(x) {
    if (hasNaN && x !== x) return false;
    return !nullSet.has(x);
  };
}
`,
          map: null,
        };
      }
      return null;
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [cspSafeApacheArrowPlugin(), react(), tailwindcss()],
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1800,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'lucide-react'],
          crdt: ['yjs'],
          table: ['@tanstack/react-table', '@tanstack/react-virtual'],
          arrow: ['apache-arrow'],
        },
      },
    },
  },
});
