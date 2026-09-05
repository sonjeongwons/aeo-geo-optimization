/**
 * src/config/apiKeys.ts — shared multi-key parsing for providers that support
 * key rotation (currently Gemini, to spread free-tier rate limits across
 * multiple Google Cloud projects/accounts — each free-tier key's quota is
 * per-project, not additive from a single project, so rotation only helps
 * when the keys come from distinct projects/accounts).
 */
export function parseApiKeyList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}
