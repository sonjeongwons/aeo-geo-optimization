/**
 * src/generate/extractPage.ts
 *
 * Pure heuristic HTML signal extractor for URL diagnosis (T06).
 *
 * DESIGN-phase1.md §"URL Diagnosis" EXTRACT step:
 *   - <title>, meta description, og:* / twitter:*, JSON-LD Organization/Product
 *     (name / sameAs / description), <h1..h3>, nav/anchor text,
 *     lang / hreflang codes.
 *   - Strip script / style / nav / footer before body-text extraction.
 *   - Truncate combined text to ~6–8 K chars.
 *
 * Contract:
 *   - PURE: input is HTML string, no IO, no async.
 *   - Returns ExtractedSignals (always a valid object; never throws).
 *   - Graceful degrade for JS-shell / empty pages: returns empty-but-valid
 *     ExtractedSignals with empty arrays and empty strings.
 *
 * No external dep beyond Node built-ins; minimal regex approach avoids
 * adding cheerio/jsdom to package.json.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HreflangEntry {
  /** BCP-47 language code from hreflang attribute. */
  lang: string;
  /** href value of the alternate link. */
  href: string;
}

export interface JsonLdEntity {
  /** @type value, e.g. "Organization" or "Product". */
  type: string;
  /** name field from the JSON-LD entity. */
  name?: string;
  /** sameAs field (string or array of strings). */
  sameAs?: string[];
  /** description field. */
  description?: string;
}

/**
 * Structured signals extracted from a fetched HTML page.
 * All fields are always present (empty string / empty array when not found).
 */
export interface ExtractedSignals {
  /** Contents of the <title> element. */
  title: string;
  /** Content of <meta name="description"> or <meta property="og:description">. */
  metaDescription: string;
  /** Open Graph metadata (og:*). Keys are the property suffix, e.g. "title", "description". */
  ogMeta: Record<string, string>;
  /** Twitter Card metadata (twitter:*). Keys are the name suffix. */
  twitterMeta: Record<string, string>;
  /** JSON-LD Organization / Product entities found on the page. */
  jsonLd: JsonLdEntity[];
  /** Text from <h1>, <h2>, <h3> elements (preserving order). */
  headings: string[];
  /** Text from anchor elements inside nav elements + top-level anchors. */
  navLinks: string[];
  /** The primary language from the root <html lang="..."> attribute. */
  htmlLang: string;
  /** hreflang alternate link entries. */
  hreflang: HreflangEntry[];
  /**
   * Combined body text (script/style/nav/footer stripped), truncated to
   * TEXT_CHAR_LIMIT chars (~6–8 K).
   */
  bodyText: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Combined-text truncation limit (~7 K chars). */
const TEXT_CHAR_LIMIT = 7_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Remove all occurrences of a block-level HTML tag and its contents.
 * Handles nested tags via repeated passes (up to MAX_PASSES).
 */
function stripTag(html: string, tag: string): string {
  // Non-greedy match for the outer tag; a simple regex is sufficient for
  // well-formed HTML (LLM tolerates noisy input anyway).
  const pattern = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "gi");
  // Two passes to handle some nesting
  return html.replace(pattern, "").replace(pattern, "");
}

/**
 * Remove all HTML tags, returning inner text.
 * Also collapses whitespace.
 */
function stripAllTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the value of a named attribute from an HTML tag snippet.
 * Returns empty string when not found.
 */
function attrValue(tagSnippet: string, attr: string): string {
  // Match attr="value" or attr='value'
  const re = new RegExp(`${attr}\\s*=\\s*["']([^"']*?)["']`, "i");
  const m = tagSnippet.match(re);
  return m?.[1]?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Extraction functions (each is a pure sub-extraction)
// ---------------------------------------------------------------------------

/** Extract <title> text. */
function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return "";
  return stripAllTags(m[1]).slice(0, 500);
}

/** Extract the primary language from <html lang="...">. */
function extractHtmlLang(html: string): string {
  const m = html.match(/<html[^>]+lang\s*=\s*["']([^"']+)["']/i);
  return m?.[1]?.trim() ?? "";
}

/** Extract <meta> tags into a flat map of { name/property → content }. */
function extractMetaTags(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const metaPattern = /<meta\s+([^>]*?)(?:\s*\/)?>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaPattern.exec(html)) !== null) {
    const tag = m[1] ?? "";
    const content = attrValue(tag, "content");
    if (!content) continue;

    const name = attrValue(tag, "name").toLowerCase();
    const property = attrValue(tag, "property").toLowerCase();

    if (name) map.set(name, content);
    if (property) map.set(property, content);
  }
  return map;
}

/** Build ogMeta record from the meta tag map. */
function extractOgMeta(metaMap: Map<string, string>): Record<string, string> {
  const og: Record<string, string> = {};
  for (const [key, val] of metaMap) {
    if (key.startsWith("og:")) {
      og[key.slice(3)] = val;
    }
  }
  return og;
}

/** Build twitterMeta record from the meta tag map. */
function extractTwitterMeta(metaMap: Map<string, string>): Record<string, string> {
  const tw: Record<string, string> = {};
  for (const [key, val] of metaMap) {
    if (key.startsWith("twitter:")) {
      tw[key.slice(8)] = val;
    }
  }
  return tw;
}

/** Extract hreflang <link rel="alternate" hreflang="..." href="..."> entries. */
function extractHreflang(html: string): HreflangEntry[] {
  const entries: HreflangEntry[] = [];
  const linkPattern = /<link\s+([^>]*?)(?:\s*\/)?>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkPattern.exec(html)) !== null) {
    const tag = m[1] ?? "";
    const rel = attrValue(tag, "rel").toLowerCase();
    if (rel !== "alternate") continue;
    const lang = attrValue(tag, "hreflang").trim();
    const href = attrValue(tag, "href").trim();
    if (lang && href) {
      entries.push({ lang, href });
    }
  }
  return entries;
}

/**
 * Extract JSON-LD Organization or Product entities.
 * Best-effort: ignores malformed JSON blocks.
 */
function extractJsonLd(html: string): JsonLdEntity[] {
  const results: JsonLdEntity[] = [];
  const scriptPattern = /<script\s[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptPattern.exec(html)) !== null) {
    const raw = m[1]?.trim() ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    // Handle both single object and @graph arrays
    const items: unknown[] = Array.isArray(parsed)
      ? parsed
      : (parsed as Record<string, unknown>)?.["@graph"]
        ? ((parsed as Record<string, unknown>)["@graph"] as unknown[])
        : [parsed];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const rawType = obj["@type"];
      const types = Array.isArray(rawType)
        ? (rawType as unknown[]).map(String)
        : [String(rawType ?? "")];

      for (const type of types) {
        if (type === "Organization" || type === "Product") {
          const entity: JsonLdEntity = { type };

          const name = obj["name"];
          if (typeof name === "string" && name) entity.name = name;

          const desc = obj["description"];
          if (typeof desc === "string" && desc) entity.description = desc.slice(0, 500);

          const sameAs = obj["sameAs"];
          if (typeof sameAs === "string" && sameAs) {
            entity.sameAs = [sameAs];
          } else if (Array.isArray(sameAs)) {
            entity.sameAs = (sameAs as unknown[])
              .filter((x): x is string => typeof x === "string" && x.length > 0)
              .slice(0, 20);
          }

          results.push(entity);
        }
      }
    }
  }
  return results;
}

/** Extract text from <h1>, <h2>, <h3> elements (in document order). */
function extractHeadings(html: string): string[] {
  const headings: string[] = [];
  const pattern = /<(h[123])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html)) !== null) {
    const text = stripAllTags(m[2] ?? "").slice(0, 300);
    if (text) headings.push(text);
  }
  return headings.slice(0, 50); // cap at 50 headings
}

/** Extract anchor text from <nav> elements and top-level <a> elements. */
function extractNavLinks(html: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();

  // Extract <nav> blocks first
  const navPattern = /<nav\b[^>]*>([\s\S]*?)<\/nav>/gi;
  let nm: RegExpExecArray | null;
  while ((nm = navPattern.exec(html)) !== null) {
    const navHtml = nm[1] ?? "";
    const aPattern = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
    let am: RegExpExecArray | null;
    while ((am = aPattern.exec(navHtml)) !== null) {
      const text = stripAllTags(am[1] ?? "").slice(0, 100);
      if (text && !seen.has(text)) {
        seen.add(text);
        links.push(text);
      }
    }
  }

  return links.slice(0, 100); // cap
}

/**
 * Strip noise tags and extract body text, truncated to TEXT_CHAR_LIMIT.
 * Removes: <script>, <style>, <nav>, <footer>, <head>.
 */
function extractBodyText(html: string): string {
  let cleaned = html;

  // Remove head entirely (includes meta/title/script in head)
  cleaned = stripTag(cleaned, "head");

  // Remove noise elements
  for (const tag of ["script", "style", "nav", "footer", "header", "aside", "noscript"]) {
    cleaned = stripTag(cleaned, tag);
  }

  const text = stripAllTags(cleaned);
  return text.slice(0, TEXT_CHAR_LIMIT);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract structured signals from fetched HTML.
 *
 * @param html - The raw HTML string from urlFetch.
 * @returns ExtractedSignals — always a valid object; never throws.
 *
 * PURE: no IO, no async, deterministic for a given input.
 */
export function extractPage(html: string): ExtractedSignals {
  // Graceful degrade: if html is empty/falsy, return valid empty signals
  if (!html || typeof html !== "string") {
    return emptySignals();
  }

  try {
    const metaMap = extractMetaTags(html);

    const title = extractTitle(html);
    const metaDescription =
      metaMap.get("description") ??
      metaMap.get("og:description") ??
      "";
    const ogMeta = extractOgMeta(metaMap);
    const twitterMeta = extractTwitterMeta(metaMap);
    const jsonLd = extractJsonLd(html);
    const headings = extractHeadings(html);
    const navLinks = extractNavLinks(html);
    const htmlLang = extractHtmlLang(html);
    const hreflang = extractHreflang(html);
    const bodyText = extractBodyText(html);

    return {
      title,
      metaDescription,
      ogMeta,
      twitterMeta,
      jsonLd,
      headings,
      navLinks,
      htmlLang,
      hreflang,
      bodyText,
    };
  } catch {
    // Belt-and-suspenders: on any unexpected error, return empty-but-valid
    return emptySignals();
  }
}

/** Return a valid ExtractedSignals with all fields empty (JS-shell degrade). */
function emptySignals(): ExtractedSignals {
  return {
    title: "",
    metaDescription: "",
    ogMeta: {},
    twitterMeta: {},
    jsonLd: [],
    headings: [],
    navLinks: [],
    htmlLang: "",
    hreflang: [],
    bodyText: "",
  };
}
