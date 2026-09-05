/**
 * src/config/env.ts
 *
 * Zod-validated environment configuration. Fails fast on startup if required
 * variables are missing. Import this module first in any entrypoint.
 *
 * Rules:
 * - DATABASE_URL is REQUIRED (hard fail if absent)
 * - GEMINI_API_KEY is OPTIONAL (adapters return NOT_CONFIGURED when absent)
 * - All other provider keys are OPTIONAL stubs
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { parseApiKeyList } from './apiKeys.js';

// Load .env if present (no-op in production where vars are injected)
loadDotenv();

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const envSchema = z.object({
  // ---- Required ----
  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL must not be empty')
    .url('DATABASE_URL must be a valid postgres:// URL'),

  // ---- Provider keys (all optional) ----
  // GEMINI_API_KEY is the only key needed for real monitoring in Phase 0
  GEMINI_API_KEY: z.string().optional(),
  // GEMINI_API_KEYS: optional comma-separated list of MULTIPLE Gemini keys
  // (from separate Google Cloud projects/accounts — free-tier quota is
  // per-project, not per-key, so keys from the SAME project don't add
  // throughput). When set, GeminiAdapter round-robins across all of them and,
  // on a 429/rate-limit, retries on the NEXT key immediately instead of
  // waiting — multiplying effective RPM by the number of distinct-project
  // keys. Falls back to the single GEMINI_API_KEY when unset (see
  // geminiApiKeys() below).
  GEMINI_API_KEYS: z
    .string()
    .optional()
    .transform((val) => parseApiKeyList(val)),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  GROK_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  LLAMA_GROQ_API_KEY: z.string().optional(),

  // ---- Judge provider selection (hi-end audit MUST #1) ----
  // Which provider runs the LLM-as-judge mention extraction. Default 'gemini'.
  // Set to e.g. 'perplexity' (a higher-citing engine) + the matching API key to
  // SUBSTITUTE the judge — makes the §5.4 disclosure ("an independent judge will
  // be substituted once a 2nd key is available") TRUE in code. Falls back to
  // gemini if the chosen provider is not 'ready' (key absent).
  JUDGE_PROVIDER: z.string().default('gemini'),

  // SOTA v3: enable Gemini Google-Search grounding globally ('on'). Off by
  // default — grounding bills the Search tool and changes WHAT is measured
  // (grounded vs ungrounded model). Per-request grounded flag overrides this.
  // Captures the fan-out + fetched-vs-cited retrieval trace on meta.grounding.
  GEMINI_GROUNDING: z.enum(['on', 'off']).default('off'),

  // Cost-controlled grounding SUBSAMPLE (v11): ground ~N% of work-units when
  // GEMINI_GROUNDING is not 'on'. A plain integer 0..100 string (validated at
  // startup so a typo/exponent form fails fast rather than silently grounding the
  // whole plan → uncapped Search billing). Consumed by providers/groundingPolicy.ts.
  GEMINI_GROUNDING_SAMPLE_PCT: z
    .string()
    .regex(/^\d{1,3}$/, 'GEMINI_GROUNDING_SAMPLE_PCT must be a plain integer 0..100')
    .refine((v) => Number(v) <= 100, 'GEMINI_GROUNDING_SAMPLE_PCT must be <= 100')
    .optional(),

  // ---- App ----
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // ---- Report permalink HMAC (hi-end audit MUST #5) ----
  // Signs/verifies /r/<token> report permalinks. Fail-fast format validation:
  // if present it MUST be >=32 chars. When ABSENT, reportToken.ts fails closed
  // unless ALLOW_DEV_REPORT_SECRET=true (or the test runner) — a forgotten secret
  // can no longer silently downgrade to a public dev HMAC key (report IDOR).
  REPORT_TOKEN_SECRET: z.string().min(32).optional(),
  ALLOW_DEV_REPORT_SECRET: z.coerce.boolean().default(false),

  // ---- Cost guardrails ----
  GLOBAL_WEEKLY_USD_CAP: z.coerce.number().positive().default(50),
  GLOBAL_MONTHLY_USD_CAP: z.coerce.number().positive().default(150),
  COST_ALERT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),

  // ---- Phase 2 content generation ceiling ----
  // Content blocks are larger than question batches; $2 default vs $0.50 for qgen.
  // Override per-deployment via CONTENT_RUN_CEILING_USD env var.
  CONTENT_RUN_CEILING_USD: z.coerce.number().positive().default(2),

  // ---- Phase 5 ops-only route guard ----
  //
  // OPS_TOKEN: when set, the legacy engine HTTP routes (GET /smr/:runId,
  // POST /diagnose) require the caller to supply this value in the
  // Authorization header as "Bearer <OPS_TOKEN>".  These routes are bound
  // to internal/ops only and must NOT be reachable as unauthenticated
  // public routes in the multi-tenant product.  If OPS_TOKEN is unset the
  // routes reject ALL requests (fail-closed).
  OPS_TOKEN: z.string().min(1).optional(),

  // ---- Phase 3 deploy connector layer ----
  //
  // OWNED_NET_OUT_DIR: filesystem output directory for the OwnedNetConnector
  // FsTarget. Defaults to ./.owned-net-out (relative to cwd). Override in
  // production to a volume path.
  OWNED_NET_OUT_DIR: z.string().min(1).default('./.owned-net-out'),

  // OWNED_NET_HUB_BASE_URL: the base URL of our owned-net hub (e.g.
  // https://hub.example.com). OPTIONAL at boot — absence does not crash startup,
  // but the OwnedNetConnector will return PublishError when it is unset and a
  // real (non-dry-run) publish is attempted. Phase 3 design requires this to be
  // set before any real publish; dry-run mode works without it.
  OWNED_NET_HUB_BASE_URL: z.string().url().optional(),

  // DEPLOY_DRY_RUN: when true (the default), the deploy pipeline runs the full
  // eligibility + throttle + connector path but writes no side effects. Must be
  // set to 'false' (or passed as --execute via CLI) for real publishes.
  //
  // NOTE: z.coerce.boolean() CANNOT be used here — it casts any non-empty string
  // to true, so DEPLOY_DRY_RUN='false' would be coerced to boolean true, making
  // it impossible for an operator to disable dry-run mode via environment variable.
  // We use an explicit enum + transform instead, defaulting to 'true' (fail-closed).
  DEPLOY_DRY_RUN: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // DEPLOY_LEASE_TIMEOUT_MS: milliseconds after which a 'leased' queue row
  // is considered stale and reclaimed to 'queued' by the reaper. Default 5 min.
  DEPLOY_LEASE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),

  // DEPLOY_DEFAULT_MAX_PER_DAY: fallback daily cap used ONLY when a channel
  // throttle policy row exists AND is enabled but has no explicit max_per_day.
  // Defaults to 0 (fail-closed) — a missing/disabled policy always blocks.
  DEPLOY_DEFAULT_MAX_PER_DAY: z.coerce.number().int().min(0).default(0),

  // CUSTOMER_DOMAIN_BLOCKLIST: comma-separated list of customer domain hosts
  // (e.g. "customer.com,shop.customer.com") that the OwnedNetConnector and
  // publishUnit must NEVER publish to. Fail-closed: an empty list is safe
  // (no customer domains are blocked by default, but the structural deferred-url
  // token already makes a customer domain unrepresentable — this is defense-in-depth).
  CUSTOMER_DOMAIN_BLOCKLIST: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(',')
            .map((h) => h.trim().toLowerCase())
            .filter((h) => h.length > 0)
        : [],
    ),
});

// ---------------------------------------------------------------------------
// Parse + export
// ---------------------------------------------------------------------------

const _parseResult = envSchema.safeParse(process.env);

if (!_parseResult.success) {
  const formatted = _parseResult.error.issues
    .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');

  // Use process.stderr so pino hasn't been initialised yet
  process.stderr.write(
    `[env] Configuration error — startup aborted:\n${formatted}\n`,
  );
  process.exit(1);
}

/**
 * Validated, typed environment configuration.
 * All consumers import { env } from '../config/env.js' instead of reading
 * process.env directly, so every access is type-safe.
 */
export const env = _parseResult.data;

// Convenience re-exports
export type Env = z.infer<typeof envSchema>;

/**
 * Resolved list of Gemini API keys to rotate across: GEMINI_API_KEYS when
 * set (comma-separated), else the single GEMINI_API_KEY wrapped in a
 * 1-element array, else empty.
 */
export function geminiApiKeys(): string[] {
  if (env.GEMINI_API_KEYS.length > 0) return env.GEMINI_API_KEYS;
  return env.GEMINI_API_KEY ? [env.GEMINI_API_KEY] : [];
}

/**
 * Returns true when at least one Gemini API key is configured.
 * Used by the provider registry's readiness() check.
 */
export function isGeminiConfigured(): boolean {
  return geminiApiKeys().length > 0;
}

/**
 * Returns true when the named provider key is set to a non-empty string.
 */
export function isProviderConfigured(keyName: keyof Env): boolean {
  const val = env[keyName];
  return typeof val === 'string' && val.length > 0;
}
