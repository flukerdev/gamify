import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Resolve the canonical site URL at build time so OG meta tags can be
// absolute. Some unfurlers (older iMessage, Twitter Cards, some Android
// messengers) refuse to resolve a relative og:image against the page URL —
// we hand them a fully-qualified URL instead.
//
// Order of precedence:
//   1. SITE_URL                            — explicit override (preferred)
//   2. VERCEL_PROJECT_PRODUCTION_URL       — canonical production domain
//   3. VERCEL_URL                          — current preview/branch deployment
//   4. ''                                  — leave tags relative as a fallback
function resolveSiteUrl(env) {
  if (env.SITE_URL) return env.SITE_URL.replace(/\/$/, '');
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return '';
}

export default defineConfig(({ mode }) => {
  // Pull from process.env too (Vercel exposes its vars there at build time;
  // loadEnv only sees VITE_*-prefixed entries from .env files).
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const siteUrl = resolveSiteUrl(env);

  return {
    plugins: [
      react(),
      {
        // Rewrite relative og:image / twitter:image / apple-touch-icon to
        // absolute URLs when we know the site origin.
        name: 'absolute-share-urls',
        transformIndexHtml(html) {
          if (!siteUrl) return html;
          return html
            .replaceAll('content="/og.png"', `content="${siteUrl}/og.png"`)
            .replaceAll('href="/apple-touch-icon.png"', `href="${siteUrl}/apple-touch-icon.png"`)
            .replaceAll('href="/favicon.svg"', `href="${siteUrl}/favicon.svg"`);
        },
      },
    ],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
  };
});
