import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Le serveur custom écoute sur 0.0.0.0, tandis que Playwright et le navigateur
  // accèdent aux assets de développement via l'adresse loopback.
  allowedDevOrigins: ['127.0.0.1'],

  // Optimisations d'images
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'api.sportcorico.com',
        pathname: '/storage/logos/**',
      },
      {
        // SportCorico a migré le stockage des logos vers Infomaniak Object Storage
        // (les anciennes URLs api.sportcorico.com/storage/logos redirigent ici en 302).
        protocol: 'https',
        hostname: 's3.pub2.infomaniak.cloud',
        pathname: '/object/v1/**',
      },
    ],
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    minimumCacheTTL: 60,
    dangerouslyAllowSVG: true,
    contentDispositionType: 'attachment',
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },

  // Optimisations de compilation
  compiler: {
    // Supprimer les console.log en production
    removeConsole: process.env.NODE_ENV === 'production' ? {
      exclude: ['error', 'warn'],
    } : false,
  },

  // Compression (activée par défaut en production)
  compress: true,

  // Headers de sécurité et performance
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            // microphone=(self) : sans ça, getUserMedia est bloqué et le navigateur
            // n'affiche jamais la boîte « Autoriser le microphone ».
            value: 'camera=(), microphone=(self), geolocation=()',
          },
        ],
      },
      {
        source: '/sw.js',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate',
          },
          {
            key: 'Service-Worker-Allowed',
            value: '/',
          },
        ],
      },
      {
        source: '/api/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'private, no-store, max-age=0',
          },
          {
            key: 'Vary',
            value: 'Cookie',
          },
        ],
      },
    ];
  },

  // Optimisations de cache
  poweredByHeader: false,
  reactStrictMode: true,
  generateEtags: true,

  // Optimisations de production build
  productionBrowserSourceMaps: false,

  // TypeORM / mysql2 hors du bundle API : le driver `mysql` 2.x mélange les
  // paquets (`PROTOCOL_INCORRECT_PACKET_SEQUENCE`) dès que deux routes
  // initialisent la connexion en parallèle.
  serverExternalPackages: ['typeorm', 'mysql', 'mysql2', 'mariadb', 'reflect-metadata'],

  // Les empreintes de migrations sont lues via readFileSync, invisible au tracing.
  outputFileTracingIncludes: {
    '/api/**/*': ['./app/lib/db/migrations/**/*'],
  },

  turbopack: {
    root: process.cwd(),
  },

  // Turbopack configuration (utilisé avec --turbo)
  experimental: {
    // Optimisations supplémentaires
    optimizePackageImports: ['lucide-react'],
  },
};

export default nextConfig;
