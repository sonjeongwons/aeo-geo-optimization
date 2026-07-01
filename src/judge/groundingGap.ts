/**
 * src/judge/groundingGap.ts — fan-out + fetched-vs-cited trace analysis (SOTA v3).
 *
 * When the Gemini Google-Search grounding tool is enabled, the API returns the
 * model's ACTUAL retrieval trace: the search sub-queries it fanned out
 * (webSearchQueries), the sources it FETCHED (groundingChunks), and which of
 * those it actually CITED in the answer (groundingSupports → chunk indices).
 *
 * This pure module turns that trace into measured diagnostics the engine could
 * previously only INFER:
 *   - fanoutQueries: the engine's real query fan-out (not hypothesized).
 *   - fetchedDomains: registrable domains the model retrieved.
 *   - citedDomains: domains actually referenced by ≥1 grounding support.
 *   - gapDomains: fetched-but-NOT-cited (the retrieval gap — got fetched, lost
 *     the citation slot).
 *   - pCitedGivenFetched: cited / fetched (how often a fetched source survives
 *     into a citation).
 *
 * §0: operates ONLY on the grounding metadata the engine's OWN answer call
 * returned — it never fetches any URL. PURE — no IO, no pg.
 */

/** Normalized grounding trace (gemini.ts maps the raw groundingMetadata to this). */
export interface GroundingTrace {
  webSearchQueries: string[];
  /**
   * Sources the model fetched. NOTE: Gemini grounding `uri` is usually a
   * `vertexaisearch.cloud.google.com/grounding-api-redirect/…` REDIRECT WRAPPER,
   * not the real source URL — so the registrable domain must come from `title`
   * (Gemini puts the source site there) for those chunks (SOTA v4 self-audit fix).
   */
  chunks: Array<{ uri: string; title?: string }>;
  /** Each support references one or more chunk indices that back an answer segment. */
  supports: Array<{ chunkIndices: number[] }>;
}

/** Host substrings that indicate a grounding redirect wrapper (not the real source). */
const REDIRECT_WRAPPERS = ["vertexaisearch.cloud.google.com", "grounding-api-redirect", "googleusercontent.com"];

/**
 * Search-engine self-reference surfaces. Gemini grounding sometimes emits a chunk
 * whose title is the search engine's OWN domain ("google.com") — the search
 * surface itself, NOT a third-party publisher you could earn a placement on
 * (confirmed on live data: many chunks come back titled exactly "google.com").
 * The earned-source TARGETING corpus + engine-overlap EXCLUDE these, the same way
 * owned/brand domains are excluded — they are not actionable/targetable earned
 * sources (§7: the targeting list must be something you can actually publish on).
 * Raw fan-out / gap diagnostics may keep them; the exclusion is a targeting-layer
 * concern applied when building earned-source signals.
 */
export const SEARCH_ENGINE_SELF_REF: ReadonlySet<string> = new Set([
  "google.com", "www.google.com", "bing.com", "duckduckgo.com",
  "search.yahoo.com", "yahoo.com", "baidu.com", "yandex.com",
]);

/** True when the domain is a search-engine self-reference surface (not a targetable earned source). */
export function isSearchEngineSelfRef(domain: string): boolean {
  return SEARCH_ENGINE_SELF_REF.has(domain.trim().toLowerCase());
}

/**
 * Bare registrable-domain-looking tokens, e.g. "reddit.com" or "bbc.co.uk".
 * Each DNS label is length-BOUNDED ({0,61}) so the matcher is linear and cannot
 * catastrophically backtrack on adversarial hyphen-heavy titles (sweep v6 Y1).
 */
const BARE_DOMAIN_G = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?/gi;

/** Hard cap on title length scanned for a domain — defense-in-depth vs ReDoS. */
const MAX_TITLE_SCAN = 2000;

/**
 * Public-suffix allowlist for the FINAL label of a bare domain found in a
 * grounding redirect-wrapper title. Without this, the old "first dotted token"
 * heuristic turned "report.pdf", "diagram.png", "config.yaml", or "v3.2" into
 * phantom fetched/earned domains polluting the earned-source corpus (SOTA v5
 * self-audit X3). A token qualifies only when its last label is a known TLD
 * (or its last two labels are a known multi-part suffix).
 */
const VALID_TLD = new Set([
  "com", "org", "net", "io", "ai", "co", "gov", "edu", "app", "dev", "info",
  "biz", "me", "tv", "news", "blog", "xyz", "tech",
  "uk", "jp", "kr", "de", "fr", "cn", "au", "br", "ca", "in", "ru", "nl",
  "es", "it", "us", "eu", "se", "ch", "kg",
]);

/** File extensions that look like a TLD but are not (reject as phantom domains). */
const FILE_EXT = new Set([
  "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "html", "htm", "doc",
  "docx", "yaml", "yml", "json", "csv", "xml", "txt", "md", "ppt", "pptx",
  "xls", "xlsx", "zip", "mp4", "mp3", "exe", "js", "ts", "py", "css",
]);

/**
 * Find the first bare-domain token in a wrapper title whose final label is a
 * real public suffix (not a file extension, not purely numeric). Returns the
 * registrable domain, or null when the title carries no valid domain.
 */
function extractDomainFromTitle(title: string): string | null {
  const matches = title.toLowerCase().slice(0, MAX_TITLE_SCAN).match(BARE_DOMAIN_G);
  if (!matches) return null;
  for (const tok of matches) {
    const labels = tok.split(".").filter(Boolean);
    if (labels.length < 2) continue;
    const last = labels[labels.length - 1]!;
    const lastTwo = labels.slice(-2).join(".");
    const suffixOk = MULTI_TLD.has(lastTwo) || VALID_TLD.has(last);
    if (!suffixOk) continue;
    if (FILE_EXT.has(last)) continue;
    if (/^[0-9]+$/.test(last)) continue; // version/number token like "v3.2"
    const reg = registrableDomain(tok);
    if (reg) return reg;
  }
  return null;
}

export interface GroundingGap {
  fanoutQueries: string[];
  fetchedDomains: string[];
  citedDomains: string[];
  /** Fetched but not cited — the retrieval gap. */
  gapDomains: string[];
  fetchedCount: number;
  citedCount: number;
  /** cited / fetched in [0,1], or null when nothing was fetched. */
  pCitedGivenFetched: number | null;
}

// Known multi-part public suffixes so "bbc.co.uk" → "bbc.co.uk" not "co.uk".
const MULTI_TLD = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "co.jp", "or.jp", "ne.jp", "co.kr",
  "or.kr", "go.kr", "com.au", "net.au", "org.au", "com.br", "com.cn",
]);

/** Extract the registrable domain (eTLD+1) from a URL — approximate, no PSL dep. */
export function registrableDomain(url: string): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  const labels = host.replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_TLD.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

/**
 * Resolve the registrable domain for a grounding chunk. When the URI is a
 * grounding REDIRECT WRAPPER (vertexaisearch/…), the real source is not in the
 * URL — fall back to a bare-domain token in the chunk `title`. Returns null when
 * neither yields a real domain (excluded rather than miscounted as google.com).
 */
export function domainForChunk(uri: string, title?: string): string | null {
  const host = (() => {
    try {
      return new URL(uri.includes("://") ? uri : `https://${uri}`).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  // Classify on the HOST only — matching the wrapper substrings against the full
  // uri (incl. PATH) misclassified a real source whose path happens to contain a
  // generic slug like "grounding-api-redirect" (sweep v6 Y5). Fall back to the
  // raw uri only when the host is unparseable.
  const isWrapper = host
    ? REDIRECT_WRAPPERS.some((w) => host.includes(w))
    : REDIRECT_WRAPPERS.some((w) => uri.includes(w));
  if (!isWrapper) return registrableDomain(uri);
  // Wrapper → derive the domain from the title (Gemini puts the source site
  // there), but ONLY accept a token whose final label is a real public suffix
  // (rejects "report.pdf"/"v3.2" phantoms — SOTA v5 self-audit X3).
  if (title) return extractDomainFromTitle(title);
  return null;
}

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs)).sort();
}

/**
 * Compute the fetched-vs-cited gap from a normalized grounding trace.
 * Returns empty/zero diagnostics for an absent or empty trace.
 */
export function computeGroundingGap(trace: GroundingTrace | null | undefined): GroundingGap {
  const empty: GroundingGap = {
    fanoutQueries: [], fetchedDomains: [], citedDomains: [], gapDomains: [],
    fetchedCount: 0, citedCount: 0, pCitedGivenFetched: null,
  };
  if (!trace) return empty;

  const chunks = trace.chunks ?? [];
  const fetchedByIdx = chunks.map((c) => domainForChunk(c.uri, c.title));
  const fetchedDomains = uniq(fetchedByIdx.filter((d): d is string => !!d));

  // A chunk is "cited" if any support references its index.
  const citedIdx = new Set<number>();
  for (const s of trace.supports ?? []) {
    for (const i of s.chunkIndices ?? []) citedIdx.add(i);
  }
  const citedDomains = uniq(
    Array.from(citedIdx).map((i) => fetchedByIdx[i]).filter((d): d is string => !!d),
  );

  const citedSet = new Set(citedDomains);
  const gapDomains = fetchedDomains.filter((d) => !citedSet.has(d));

  return {
    fanoutQueries: uniq(trace.webSearchQueries ?? []),
    fetchedDomains,
    citedDomains,
    gapDomains,
    fetchedCount: fetchedDomains.length,
    citedCount: citedDomains.length,
    pCitedGivenFetched: fetchedDomains.length > 0 ? citedDomains.length / fetchedDomains.length : null,
  };
}
