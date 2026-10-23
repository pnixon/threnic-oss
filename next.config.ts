import type { NextConfig } from 'next';
import withBundleAnalyzer from '@next/bundle-analyzer';

const analyzer = withBundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
  openAnalyzer: false,
});

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: false },
  output: 'standalone',
  async redirects() {
    // The editor used to live at /app; it is now served at /.
    return [{ source: '/app', destination: '/', permanent: true }];
  },
  async headers() {
    return [
      {
        // ── Baseline security headers (all routes) ───────────────────────────
        // `frame-ancestors 'self'` is ENFORCED now (clickjacking protection).
        // A full Content-Security-Policy is shipped in REPORT-ONLY mode below so
        // we can observe violations in the field before enforcing it — flip the
        // header name to `Content-Security-Policy` once the reports are clean.
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
          {
            key: 'Content-Security-Policy-Report-Only',
            value: [
              "default-src 'self'",
              // Next injects an inline bootstrap without a nonce; 'unsafe-eval'
              // is only needed by the dev/Turbopack runtime.
              `script-src 'self' 'unsafe-inline'${
                process.env.NODE_ENV !== 'production' ? " 'unsafe-eval'" : ''
              }`,
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "img-src 'self' data: blob: https:",
              "media-src 'self' blob:",
              "font-src 'self' data: https://fonts.gstatic.com",
              "connect-src 'self'",
              "worker-src 'self' blob:",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'self'",
            ].join('; '),
          },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'Permissions-Policy',
            value: 'geolocation=(), camera=(), browsing-topics=()',
          },
        ],
      },
      {
        // Cross-origin isolation (SharedArrayBuffer, high-resolution timers, etc.)
        source: '/:path*',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'require-corp',
          },
        ],
      },
    ];
  },
};

export default analyzer(nextConfig);
