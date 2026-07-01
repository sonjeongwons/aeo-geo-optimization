import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Node 22 runtime for all server-side code (NOT Edge)
  // This ensures pg/kysely/pino modules work properly
  experimental: {
    // Server-only imports enforced structurally via "server-only" package
  },
  // The server/client boundary is enforced at build time by the `server-only`
  // package (a Client Component importing a server module fails the webpack
  // compile) PLUS strict TypeScript — both pass. ESLint runs SEPARATELY via
  // `npm run lint`; its no-restricted-imports rule cannot distinguish Server
  // Components (which legitimately import @engine/db|billing|metrics) from
  // Client Components by path, so it false-positives on RSC pages. Lint is a
  // code-quality gate, not the boundary guard, so it does not gate the build.
  eslint: { ignoreDuringBuilds: true },
  webpack: (config) => {
    // The engine (src/*) uses NodeNext ESM, so its relative imports carry a
    // ".js" extension that actually resolves to a ".ts" source file. webpack's
    // bundler resolution does not do that .js->.ts rewrite by default, breaking
    // any @engine/* import that pulls in a raw engine module
    // (e.g. lib/actions/templates.ts -> src/cli/reviewTemplate.ts -> "../db/repo.js").
    // extensionAlias makes webpack try the .ts source for a ".js" specifier.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
