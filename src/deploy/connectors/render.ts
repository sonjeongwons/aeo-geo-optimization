/**
 * src/deploy/connectors/render.ts
 *
 * T07 — Pure deterministic HTML + JSON-LD renderers per ContentBody content_type.
 *
 * Rules:
 * - PURE: no IO, no side effects; same inputs → byte-identical output.
 * - Renders disclosure_tag into the artifact (§7#6).
 * - Stamps datePublished from the caller-supplied Date (OwnedNetConnector passes now()).
 * - Supports all ContentBody content_type values:
 *     definition, answer_block, faq, comparison, case_study, jsonld
 *
 * DESIGN-phase3.md §"Owned-Net (real today)" step 3.
 * SPEC §7#6 disclosure, §8 owned_net.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import type {
  ContentBody,
  JsonLd,
  DefinitionSentenceBody,
  AnswerBlockBody,
  FaqBody,
  ComparisonBody,
  CaseStudyBody,
  JsonLdBody,
} from "../../content/types.js";

// ---------------------------------------------------------------------------
// RenderInput — everything needed to produce a deterministic HTML page
// ---------------------------------------------------------------------------

export interface RenderInput {
  /** Typed content body from content_asset. */
  body: ContentBody;
  /**
   * Optional JSON-LD to embed (stamped with datePublished by caller).
   * Use undefined (not null) to omit; exactOptionalPropertyTypes requires
   * the property to be absent rather than explicitly null when omitting.
   */
  jsonLd?: JsonLd;
  /** Sponsorship/affiliation disclosure tag (§7#6). May be null for owned_net. */
  disclosureTag: string | null;
  /** Canonical URL for <link rel=canonical>. */
  canonicalUrl: string;
  /** BCP-47 language code for <html lang>. */
  language: string;
  /** ISO-8601 datePublished string (stamped at publish time). */
  datePublished: string;
}

// ---------------------------------------------------------------------------
// Escape helpers — deterministic, safe
// ---------------------------------------------------------------------------

/** Escape HTML special characters for safe embedding in attribute or text content. */
function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Deterministically serialize JSON for <script type=application/ld+json>. */
function serializeJsonLd(obj: unknown): string {
  // Sorted keys for determinism — same object always produces the same bytes.
  return JSON.stringify(obj, sortedReplacer, 2);
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Disclosure banner (§7#6)
// ---------------------------------------------------------------------------

function disclosureBanner(tag: string | null): string {
  if (!tag) return "";
  return `\n  <aside class="disclosure" role="note">\n    <small>${esc(tag)}</small>\n  </aside>`;
}

// ---------------------------------------------------------------------------
// Shared page wrapper
// ---------------------------------------------------------------------------

function htmlPage(opts: {
  lang: string;
  canonical: string;
  datePublished: string;
  title: string;
  main: string;
  jsonLd?: JsonLd;
  disclosureTag: string | null;
}): string {
  const jsonLdBlock = opts.jsonLd
    ? `\n  <script type="application/ld+json">\n${serializeJsonLd(opts.jsonLd)}\n  </script>`
    : "";

  const disclosure = disclosureBanner(opts.disclosureTag);

  // Research rank-7 (freshness/QDF): emit datePublished AND dateModified, plus a
  // VISIBLE on-page "last updated" date. For a first publish these are equal and
  // genuine (the page was created at this instant) — §7-honest. A future
  // change-triggered republish updates dateModified ONLY when content materially
  // changes (never a time-triggered restamp, which would manufacture freshness).
  const iso = opts.datePublished;
  const ymd = esc(iso.slice(0, 10));

  return `<!DOCTYPE html>
<html lang="${esc(opts.lang)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="canonical" href="${esc(opts.canonical)}">
  <link rel="alternate" type="text/markdown" href="${esc(opts.canonical.endsWith("/") ? opts.canonical + "index.md" : opts.canonical + ".md")}">
  <meta name="date" content="${esc(iso)}">
  <meta name="last-modified" content="${esc(iso)}">${jsonLdBlock}
  <title>${esc(opts.title)}</title>
</head>
<body>
  <main>${disclosure}
${opts.main}
  </main>
  <footer>
    <p><time datetime="${esc(iso)}">Last updated: ${ymd}</time></p>
  </footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Per-content_type renderers
// ---------------------------------------------------------------------------

/**
 * Build the shared htmlPage opts, spreading jsonLd only when present.
 * This satisfies exactOptionalPropertyTypes by never passing jsonLd: undefined.
 */
function buildPageOpts(opts: {
  lang: string;
  canonical: string;
  datePublished: string;
  title: string;
  main: string;
  jsonLd: JsonLd | undefined;
  disclosureTag: string | null;
}): Parameters<typeof htmlPage>[0] {
  const { jsonLd, ...rest } = opts;
  if (jsonLd !== undefined) {
    return { ...rest, jsonLd };
  }
  return rest;
}

function renderDefinition(body: DefinitionSentenceBody, input: RenderInput): string {
  const main = `    <article class="definition">
      <p>${esc(body.text)}</p>
    </article>`;
  return htmlPage(buildPageOpts({
    lang: input.language,
    canonical: input.canonicalUrl,
    datePublished: input.datePublished,
    title: esc(body.text).slice(0, 60),
    main,
    jsonLd: input.jsonLd,
    disclosureTag: input.disclosureTag,
  }));
}

function renderAnswerBlock(body: AnswerBlockBody, input: RenderInput): string {
  const main = `    <article class="answer-block">
      <p>${esc(body.text)}</p>
    </article>`;
  return htmlPage(buildPageOpts({
    lang: input.language,
    canonical: input.canonicalUrl,
    datePublished: input.datePublished,
    title: esc(body.text).slice(0, 60),
    main,
    jsonLd: input.jsonLd,
    disclosureTag: input.disclosureTag,
  }));
}

function renderFaq(body: FaqBody, input: RenderInput): string {
  const rows = body.rows
    .map(
      (row) =>
        `      <details class="faq-item">\n        <summary>${esc(row.q)}</summary>\n        <p>${esc(row.a)}</p>\n      </details>`
    )
    .join("\n");

  const main = `    <article class="faq">
      <dl>
${rows}
      </dl>
    </article>`;

  const title = body.rows[0] != null ? esc(body.rows[0].q).slice(0, 60) : "FAQ";

  return htmlPage(buildPageOpts({
    lang: input.language,
    canonical: input.canonicalUrl,
    datePublished: input.datePublished,
    title,
    main,
    jsonLd: input.jsonLd,
    disclosureTag: input.disclosureTag,
  }));
}

function renderComparison(body: ComparisonBody, input: RenderInput): string {
  const headerCells = body.columns
    .map((col) => `        <th>${esc(col)}</th>`)
    .join("\n");

  const dataRows = body.rows
    .map((row) => {
      const cells = row.cells
        .map((cell) => `        <td>${esc(cell.value)}</td>`)
        .join("\n");
      return `      <tr>\n        <td>${esc(row.entity)}</td>\n${cells}\n      </tr>`;
    })
    .join("\n");

  const main = `    <article class="comparison">
      <table>
        <thead>
          <tr>
${headerCells}
          </tr>
        </thead>
        <tbody>
${dataRows}
        </tbody>
      </table>
    </article>`;

  const title =
    body.columns.length > 0
      ? esc(body.columns[0]!).slice(0, 60)
      : "Comparison";

  return htmlPage(buildPageOpts({
    lang: input.language,
    canonical: input.canonicalUrl,
    datePublished: input.datePublished,
    title,
    main,
    jsonLd: input.jsonLd,
    disclosureTag: input.disclosureTag,
  }));
}

function renderCaseStudy(body: CaseStudyBody, input: RenderInput): string {
  const metrics = body.metrics
    .map(
      (m) =>
        `      <tr>\n        <td>${esc(m.label)}</td>\n        <td>${esc(m.before)}</td>\n        <td>${esc(m.after)}</td>\n      </tr>`
    )
    .join("\n");

  const metricsTable =
    body.metrics.length > 0
      ? `\n      <table class="metrics">
        <thead><tr><th>Metric</th><th>Before</th><th>After</th></tr></thead>
        <tbody>
${metrics}
        </tbody>
      </table>`
      : "";

  const main = `    <article class="case-study">
      <section class="situation"><h2>Situation</h2><p>${esc(body.situation)}</p></section>
      <section class="action"><h2>Action</h2><p>${esc(body.action)}</p></section>
      <section class="result"><h2>Result</h2><p>${esc(body.result)}</p></section>${metricsTable}
    </article>`;

  const title = esc(body.situation).slice(0, 60);

  return htmlPage(buildPageOpts({
    lang: input.language,
    canonical: input.canonicalUrl,
    datePublished: input.datePublished,
    title,
    main,
    jsonLd: input.jsonLd,
    disclosureTag: input.disclosureTag,
  }));
}

function renderJsonLdPage(body: JsonLdBody, input: RenderInput): string {
  // For jsonld content_type, the JSON-LD IS the body's json field.
  // We render a minimal page embedding it.
  const effectiveJsonLd = body.json as JsonLd;
  const schemaType = body.schema_type;
  const title = `${schemaType} — Structured Data`;

  const main = `    <article class="jsonld-page">
      <p>Structured data: ${esc(schemaType)}</p>
    </article>`;

  // Use passed-in jsonLd if available, else fall back to body.json.
  const resolvedJsonLd: JsonLd = input.jsonLd ?? effectiveJsonLd;

  return htmlPage(buildPageOpts({
    lang: input.language,
    canonical: input.canonicalUrl,
    datePublished: input.datePublished,
    title,
    main,
    jsonLd: resolvedJsonLd,
    disclosureTag: input.disclosureTag,
  }));
}

// ---------------------------------------------------------------------------
// Sitemap entry type
// ---------------------------------------------------------------------------

export interface SitemapEntry {
  loc: string;
  lastmod: string;
}

// ---------------------------------------------------------------------------
// renderSitemap — deterministic XML sitemap
// ---------------------------------------------------------------------------

/**
 * Render a deterministic XML sitemap from entries.
 * Sorted by loc for byte-identical output across runs.
 */
export function renderSitemap(entries: SitemapEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.loc.localeCompare(b.loc));
  const urls = sorted
    .map(
      (e) =>
        `  <url>\n    <loc>${esc(e.loc)}</loc>\n    <lastmod>${esc(e.lastmod)}</lastmod>\n  </url>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

// ---------------------------------------------------------------------------
// renderPage — main entry point
// ---------------------------------------------------------------------------

/**
 * Render a deterministic static HTML page for any ContentBody type.
 *
 * PURE: same inputs → byte-identical output (guaranteed by sorted JSON-LD keys
 * and deterministic template structure).
 *
 * @param input  All rendering inputs (body, jsonLd, disclosureTag, canonicalUrl, language, datePublished).
 * @returns      UTF-8 HTML string, ready to write as index.html.
 */
export function renderPage(input: RenderInput): string {
  const { body } = input;
  switch (body.content_type) {
    case "definition":
      return renderDefinition(body, input);
    case "answer_block":
      return renderAnswerBlock(body, input);
    case "faq":
      return renderFaq(body, input);
    case "comparison":
      return renderComparison(body, input);
    case "case_study":
      return renderCaseStudy(body, input);
    case "jsonld":
      return renderJsonLdPage(body, input);
    default: {
      // TypeScript exhaustiveness check
      const _never: never = body;
      throw new Error(
        `renderPage: unhandled content_type: ${JSON.stringify((_never as ContentBody).content_type)}`
      );
    }
  }
}
