"use strict";

module.exports = {
  extends: ["next/core-web-vitals"],
  plugins: ["@typescript-eslint"],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  rules: {
    // Forbid importing server-only engine modules in client components.
    // @engine/domain/* (pure types) is the ONLY @engine/* allowed in client files.
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: [
              "@engine/db",
              "@engine/db/*",
              "@engine/metrics",
              "@engine/metrics/*",
              "@engine/providers",
              "@engine/providers/*",
              "@engine/scheduler",
              "@engine/scheduler/*",
              "@engine/billing",
              "@engine/billing/*",
              "@engine/report",
              "@engine/report/*",
              "@engine/api",
              "@engine/api/*",
              "@engine/auth",
              "@engine/auth/*",
            ],
            message:
              "Server-only engine modules cannot be imported in client components. " +
              "Only @engine/domain/* (pure types) may cross the client boundary.",
          },
        ],
      },
    ],
  },
  overrides: [
    {
      // Relax the restriction in server-only files (route handlers, server actions, etc.)
      files: [
        "**/app/api/**/*.ts",
        "**/app/api/**/*.tsx",
        "**/lib/engine.server.ts",
        "**/lib/session.ts",
        "**/lib/actions/**/*.ts",
        "**/lib/actions/**/*.tsx",
      ],
      rules: {
        "no-restricted-imports": "off",
      },
    },
  ],
};
