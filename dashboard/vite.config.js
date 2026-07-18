/**
 * vite.config.js — build config for the AOP merchant dashboard SPA.
 *
 * Role in the AOP data flow: none at runtime — the dashboard builds to
 * static assets (dist/) served by any static host / the Shopify app shell.
 * Dev-server proxying is deliberately NOT configured: the SPA talks to the
 * ingestion /analytics API and the optimizer microservice via the URLs in
 * its Settings tab (persisted in localStorage), which mirrors production
 * where the three processes are separate deployments.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Deterministic output dir; CI uploads/serves dist/ as-is.
    outDir: 'dist',
    sourcemap: false,
  },
});
