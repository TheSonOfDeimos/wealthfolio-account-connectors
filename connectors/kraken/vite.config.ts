import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Packages the host provides at runtime. They are marked external so the
 * bundle does not ship a second copy of React (two React modules in one page
 * is the classic "hooks stop working" failure). Keep this list in sync with
 * `hostDependencies` in manifest.json.
 */
const hostProvidedDependencies = [
  '@wealthfolio/addon-sdk',
  '@wealthfolio/addon-sdk/host-api',
  '@wealthfolio/addon-sdk/manifest',
  '@wealthfolio/addon-sdk/permissions',
  '@wealthfolio/addon-sdk/types',
  '@wealthfolio/addon-sdk/utils',
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-dev-runtime',
  'react/jsx-runtime',
];

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    // Pinned explicitly so a future Vite default cannot raise the addon's
    // browser floor above what Wealthfolio's sandbox supports.
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    lib: {
      entry: 'src/addon.tsx',
      formats: ['es'],
      fileName: () => 'addon.js',
    },
    outDir: 'dist',
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: hostProvidedDependencies,
    },
  },
});
