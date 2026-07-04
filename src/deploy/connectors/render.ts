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
 * AEO/GEO quality overhaul (roadmap W4/W5/W9):
 * - Every page ships a small, deterministic, CJK-aware stylesheet + dark mode +
 *   responsive viewport (W5.2) so a human landing from an AI citation sees a
 *   credible, readable page (trust is itself an AEO signal).
 * - A visible brand/home link at the top of every page (W5.5).
 * - Valid FAQ markup — a <div class="faq-list"> of <details>, never a <dl>
 *   wrapping <details> (W5.5).
 * - A SHORT, distinct <h1>/<title>/headline derived by word-boundary truncation
 *   from the body — never the full multi-sentence block (W5.4).
 * - A pipe-table guard: markdown-table markup ("| --- |") never leaks into the
 *   h1/title/meta/JSON-LD of a miscategorised answer_block (W5.1).
 * - Auto-derived JSON-LD covers DefinedTerm (definition), Article (prose),
 *   FAQPage (faq) with an author Organization node and case_study before/after
 *   metrics folded into articleBody (W4.3/W4.4).
 * - renderRobots() emits a citation-bot-friendly robots.txt (W9.1).
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
  /**
   * Optional brand identity for entity-disambiguation markup (AEO/GEO): drives
   * the Organization publisher/about in the auto-derived JSON-LD and a visible
   * "About <brand>" blurb linking the official site (sameAs). Omit for a
   * brand-agnostic page.
   */
  brand?: {
    name: string;
    url?: string;
    sameAs?: string[];
    description?: string;
  };
  /**
   * Optional related-page links (hub-graph internal linking — a first-class
   * discovery lever). Rendered as a <nav class="related"> list.
   */
  relatedLinks?: Array<{ url: string; title: string }>;
  /**
   * Optional verified references (W4.2) — the bound claim_sources behind this
   * page's factual claims. Rendered as a visible <section class="references">
   * <cite> list AND schema.org `citation`. Research P0 "Cite-Sources" lever
   * (+115% for low-authority hubs — exactly a new GitHub Pages hub). §7-safe:
   * ONLY pass verified sources (never fabricated citations).
   */
  references?: Array<{ text: string; url?: string }>;
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
// Text-shaping helpers — short headlines, pipe-table guard (W5.1/W5.4)
// ---------------------------------------------------------------------------

/** True when a line is a markdown table row / delimiter ("| a | b |", "|---|"). */
function isPipeTableLine(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("|")) return false;
  // A delimiter row (---) or any row carrying >=2 pipes is table markup.
  if (/^\|[\s:|-]+\|?$/.test(t)) return true;
  return (t.match(/\|/g)?.length ?? 0) >= 2;
}

/**
 * Strip markdown-table lines from prose so pipe markup never lands in an
 * h1/title/meta/JSON-LD field (W5.1). Non-table prose is preserved verbatim.
 */
function stripPipeTables(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !isPipeTableLine(l))
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** First sentence of a block (up to a Latin or CJK terminator), else the whole. */
function firstSentence(text: string): string {
  const m = text.match(/^[\s\S]*?[.。!?！？](?=\s|$)/);
  const s = (m ? m[0] : text).trim();
  return s.length > 0 ? s : text.trim();
}

/**
 * Truncate to at most `max` visible units without cutting mid-word for
 * space-delimited scripts. CJK (no spaces) truncates at the character boundary.
 * Appends an ellipsis only when truncation actually happened.
 */
function truncateAtBoundary(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  // If the source uses spaces, prefer the last word boundary; otherwise (CJK)
  // the raw character slice is already a clean boundary.
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s,;:।、，；：]+$/, "") + "…";
}

/** Remove stray inline table pipes and collapse whitespace (for headings). */
function cleanInline(text: string): string {
  return text.replace(/\|+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Derive a short, pipe-free headline (for h1/title/JSON-LD headline). May be ""
 * for a body that is entirely table markup / whitespace — callers MUST supply a
 * non-empty fallback via headlineOr() so no empty <h1>/DefinedTerm name ships.
 */
function headlineOf(text: string, max = 70): string {
  const cleaned = cleanInline(stripPipeTables(text));
  const s = firstSentence(cleaned);
  return s ? truncateAtBoundary(s, max) : "";
}

/** headlineOf with a guaranteed non-empty result (falls back to `fallback`). */
function headlineOr(text: string, fallback: string, max = 70): string {
  const h = headlineOf(text, max);
  return h.length > 0 ? h : fallback;
}

/** The best non-empty title fallback for a page: brand name, else a label. */
function fallbackTitle(input: RenderInput, label: string): string {
  return input.brand?.name ?? label;
}

// ---------------------------------------------------------------------------
// Deterministic page stylesheet (W5.2) — constant string for byte-stability.
// System + CJK font stack, readable column, table borders, dark mode, mobile.
// ---------------------------------------------------------------------------

export const PAGE_STYLE =
  ":root{color-scheme:light dark}" +
  "*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}" +
  'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,' +
  '"Helvetica Neue","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",' +
  '"Noto Sans JP","Hiragino Kaku Gothic ProN","Noto Sans SC",sans-serif;' +
  "line-height:1.7;color:#1a1a1a;background:#fff}" +
  "header.site{max-width:720px;margin:0 auto;padding:1rem 1.25rem 0}" +
  "header.site a{color:#0b5fff;text-decoration:none;font-weight:600}" +
  "main{max-width:720px;margin:0 auto;padding:1rem 1.25rem}" +
  "h1{font-size:1.6rem;line-height:1.3;margin:.4rem 0 1rem}" +
  "h2{font-size:1.2rem;line-height:1.35;margin:1.8rem 0 .6rem}" +
  "p{margin:0 0 1rem}article>p{font-size:1.07rem}a{color:#0b5fff}" +
  "table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:.95rem}" +
  "th,td{border:1px solid #d0d7de;padding:.5rem .7rem;text-align:left;vertical-align:top}" +
  "th{background:#f6f8fa;font-weight:600}" +
  "div.faq-list{margin:1rem 0}" +
  "details.faq-item{border:1px solid #d0d7de;border-radius:6px;padding:.2rem .8rem;margin:.5rem 0}" +
  "details.faq-item summary{cursor:pointer;font-weight:600;padding:.5rem 0}" +
  "aside.about{background:#f6f8fa;border-left:3px solid #0b5fff;padding:.7rem 1rem;" +
  "margin:1.6rem 0;font-size:.95rem;border-radius:0 6px 6px 0}" +
  "aside.disclosure{color:#57606a;font-size:.85rem;margin:0 0 1rem}" +
  "nav.related{margin:2rem 0 0;border-top:1px solid #d0d7de;padding-top:1rem}" +
  "nav.related h2{font-size:1rem;margin:.2rem 0 .5rem}" +
  "nav.related ul{margin:0;padding-left:1.1rem}nav.related li{margin:.3rem 0}" +
  "section.references{margin:1.8rem 0 0;border-top:1px solid #d0d7de;padding-top:1rem;font-size:.9rem}" +
  "section.references h2{font-size:1rem;margin:.2rem 0 .5rem}" +
  "section.references ul{margin:0;padding-left:1.1rem}section.references li{margin:.3rem 0}" +
  "section.references cite{font-style:normal;color:#57606a}" +
  "footer{max-width:720px;margin:2rem auto 0;padding:1rem 1.25rem 2rem;" +
  "border-top:1px solid #d0d7de;color:#57606a;font-size:.85rem}" +
  "@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}" +
  "th{background:#161b22}aside.about,details.faq-item{background:#161b22;border-color:#30363d}" +
  "th,td{border-color:#30363d}a,header.site a{color:#4c9aff}" +
  "nav.related,footer{border-color:#30363d}}" +
  "@media(max-width:480px){main{padding:1rem}h1{font-size:1.38rem}}";

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
  description?: string;
  /** Visible top-of-page brand/home link (W5.5). */
  home: { url: string; label: string };
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
  <meta name="last-modified" content="${esc(iso)}">${opts.description ? `\n  <meta name="description" content="${esc(opts.description)}">` : ""}
  <meta property="og:type" content="article">
  <meta property="og:title" content="${esc(opts.title)}">${opts.description ? `\n  <meta property="og:description" content="${esc(opts.description)}">` : ""}
  <meta property="og:url" content="${esc(opts.canonical)}">
  <style>${PAGE_STYLE}</style>${jsonLdBlock}
  <title>${esc(opts.title)}</title>
</head>
<body>
  <header class="site"><a href="${esc(opts.home.url)}" rel="home">${esc(opts.home.label)}</a></header>
  <main>${disclosure}
${opts.main}
  </main>
  <footer>
    <p><a href="${esc(opts.home.url)}" rel="home">${esc(opts.home.label)}</a> · <time datetime="${esc(iso)}">Last updated: ${ymd}</time></p>
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
  description?: string;
  home: { url: string; label: string };
}): Parameters<typeof htmlPage>[0] {
  const { jsonLd, ...rest } = opts;
  if (jsonLd !== undefined) {
    return { ...rest, jsonLd };
  }
  return rest;
}

/** The top-of-page brand/home link target + label for an input. */
function homeOf(input: RenderInput): { url: string; label: string } {
  return { url: websiteBase(input.canonicalUrl), label: input.brand?.name ?? "Home" };
}

// ---------------------------------------------------------------------------
// AEO/GEO enrichment helpers — inline JSON-LD, entity blurb, hub-graph links
// ---------------------------------------------------------------------------

/** WebSite base (origin + first path segment = the hub root) from a canonical URL. */
function websiteBase(canonical: string): string {
  try {
    const u = new URL(canonical);
    const seg = u.pathname.split("/").filter(Boolean);
    return seg.length > 0 ? `${u.origin}/${seg[0]}/` : `${u.origin}/`;
  } catch {
    return canonical;
  }
}

/** Organization node from brand identity (name + optional url/sameAs/description). */
function brandOrg(brand: NonNullable<RenderInput["brand"]>): Record<string, unknown> {
  return {
    "@type": "Organization",
    name: brand.name,
    ...(brand.url ? { url: brand.url } : {}),
    ...(brand.sameAs && brand.sameAs.length > 0 ? { sameAs: brand.sameAs } : {}),
    ...(brand.description ? { description: brand.description } : {}),
  };
}

/**
 * Auto-derive schema.org JSON-LD from the body so EVERY page carries structured
 * data (the #1 AEO/GEO citation lever). Mapping:
 *   faq        → FAQPage (mainEntity Q/A)
 *   definition → DefinedTerm (name + description)   (W4.3)
 *   others     → Article (headline + articleBody)
 * inLanguage + datePublished/dateModified + url + isPartOf WebSite are always set;
 * publisher + author + about Organization when a brand is supplied (W4.3). jsonld
 * pages already carry their own JSON-LD, so they are skipped. case_study before/
 * after metrics are folded into articleBody so the most citable numbers survive
 * into structured data (W4.4). Deterministic (no clock/random; htmlPage
 * serializes with sorted keys).
 */
function deriveJsonLd(body: ContentBody, input: RenderInput): JsonLd | undefined {
  if (body.content_type === "jsonld") return undefined;
  const hub = websiteBase(input.canonicalUrl);
  const brand = input.brand;
  const org = brand ? brandOrg(brand) : undefined;
  const isPartOf = { "@type": "WebSite", url: hub, ...(brand ? { name: brand.name } : {}) };
  const refs = input.references ?? [];
  const common = {
    "@context": "https://schema.org",
    inLanguage: input.language,
    url: input.canonicalUrl,
    datePublished: input.datePublished,
    dateModified: input.datePublished,
    isPartOf,
    ...(org ? { publisher: org, author: org } : {}),
    // W4.2 schema.org citation — the verified sources behind the page's claims.
    ...(refs.length > 0
      ? { citation: refs.map((r) => ({ "@type": "CreativeWork", name: r.text, ...(r.url ? { url: r.url } : {}) })) }
      : {}),
  };

  if (body.content_type === "faq") {
    return {
      ...common,
      "@type": "FAQPage",
      mainEntity: body.rows.map((r) => ({
        "@type": "Question",
        name: r.q,
        acceptedAnswer: { "@type": "Answer", text: r.a },
      })),
    } as unknown as JsonLd;
  }

  if (body.content_type === "definition") {
    // A definition is a DefinedTerm, not an Article (W4.3). name/description MUST
    // be non-empty (schema.org requires it) even for a pathological body.
    const dtName = headlineOr(body.text, brand?.name ?? "Definition", 90);
    const dtDesc = cleanInline(stripPipeTables(body.text)) || dtName;
    return {
      ...common,
      "@type": "DefinedTerm",
      name: dtName,
      description: dtDesc,
      ...(org ? { inDefinedTermSet: { "@type": "DefinedTermSet", name: brand!.name, url: hub } } : {}),
    } as unknown as JsonLd;
  }

  let articleBody = "";
  switch (body.content_type) {
    case "answer_block":
      articleBody = cleanInline(stripPipeTables(body.text));
      break;
    case "comparison":
      articleBody = body.rows
        .map((r) => `${r.entity}: ${r.cells.map((c) => c.value).join(", ")}`)
        .join(". ");
      break;
    case "case_study": {
      // Fold the before/after metrics into articleBody so the most citable
      // numbers survive into structured data (W4.4).
      const metricsText = body.metrics
        .map((m) => `${m.label}: ${m.before} → ${m.after}`)
        .join("; ");
      articleBody = [body.situation, body.action, body.result, metricsText]
        .filter((s) => s && s.trim().length > 0)
        .join(" ");
      break;
    }
  }
  const headline =
    body.content_type === "comparison"
      ? (body.columns.length > 0 ? body.columns.join(" vs ") : fallbackTitle(input, "Comparison"))
      : body.content_type === "case_study"
        ? headlineOr(body.situation, fallbackTitle(input, "Case study"), 110)
        : headlineOr(body.text, fallbackTitle(input, "Article"), 110);
  return {
    ...common,
    "@type": "Article",
    // articleBody is schema.org-required non-empty; fall back to the headline.
    headline,
    articleBody: articleBody.trim().length > 0 ? articleBody : headline,
    ...(org ? { about: { "@type": "Organization", name: brand!.name } } : {}),
  } as unknown as JsonLd;
}

/** Visible "About <brand>" entity blurb linking the official site (sameAs echo). */
function aboutBrandHtml(brand: RenderInput["brand"], lang: string): string {
  if (!brand) return "";
  const l2 = lang.split("-")[0]?.toLowerCase() ?? "en";
  const officialLabel =
    l2 === "ko" ? "공식 사이트" : l2 === "ja" ? "公式サイト" : l2 === "zh" ? "官方网站" : "Official site";
  // End the description with a full stop before the label so CJK prose doesn't
  // run into it (expressiveness/readability).
  const rawDesc = brand.description ? brand.description.trim() : "";
  const descPunct = /[.。!?！？]$/.test(rawDesc) ? "" : l2 === "ko" || l2 === "ja" || l2 === "zh" ? "." : ".";
  const desc = rawDesc ? ` — ${esc(rawDesc)}${descPunct}` : "";
  const link = brand.url
    ? ` ${officialLabel}: <a href="${esc(brand.url)}">${esc(brand.url)}</a>`
    : "";
  return `\n      <aside class="about"><p><strong>${esc(brand.name)}</strong>${desc}${link}</p></aside>`;
}

/** Hub-graph internal links (discovery lever) as a <nav class="related"> list. */
function relatedLinksHtml(links: RenderInput["relatedLinks"], lang: string): string {
  if (!links || links.length === 0) return "";
  const l2 = lang.split("-")[0]?.toLowerCase() ?? "en";
  const heading = l2 === "ko" ? "관련 페이지" : l2 === "ja" ? "関連ページ" : l2 === "zh" ? "相关页面" : "Related";
  const items = links
    .map((l) => `        <li><a href="${esc(l.url)}">${esc(l.title)}</a></li>`)
    .join("\n");
  return `\n      <nav class="related" aria-label="${esc(heading)}">\n        <h2>${esc(heading)}</h2>\n        <ul>\n${items}\n        </ul>\n      </nav>`;
}

/**
 * Visible verified-references block (W4.2) — the bound claim_sources behind the
 * page's facts, as a <cite> list. Language-aware heading. §7-safe (caller passes
 * only verified sources).
 */
function referencesHtml(refs: RenderInput["references"], lang: string): string {
  if (!refs || refs.length === 0) return "";
  const l2 = lang.split("-")[0]?.toLowerCase() ?? "en";
  const heading = l2 === "ko" ? "출처" : l2 === "ja" ? "出典" : l2 === "zh" ? "来源" : "Sources";
  const items = refs
    .map((r) => {
      const inner = r.url ? `<a href="${esc(r.url)}">${esc(r.text)}</a>` : esc(r.text);
      return `        <li><cite>${inner}</cite></li>`;
    })
    .join("\n");
  return `\n      <section class="references" aria-label="${esc(heading)}">\n        <h2>${esc(heading)}</h2>\n        <ul>\n${items}\n        </ul>\n      </section>`;
}

/**
 * Compose the <article> body: a semantic H1 + the type-specific inner HTML +
 * the entity blurb + verified references + related links. Shared by every
 * content renderer so all pages get the same AEO structure.
 */
function composeArticle(cls: string, h1: string, innerHtml: string, input: RenderInput): string {
  return `    <article class="${cls}">
      <h1>${esc(h1)}</h1>
${innerHtml}${aboutBrandHtml(input.brand, input.language)}${referencesHtml(input.references, input.language)}${relatedLinksHtml(input.relatedLinks, input.language)}
    </article>`;
}

/** First-sentence-ish meta description, pipe-free, bounded to ~160 chars for SERP/AEO. */
function metaDescription(text: string): string {
  const t = stripPipeTables(text).replace(/\s+/g, " ").trim();
  return t.length <= 160 ? t : t.slice(0, 157).trimEnd() + "…";
}

/**
 * Render prose that MAY contain a stray markdown table (a miscategorised
 * comparison stored as answer_block, W5.1). Non-table lines become <p>; a run
 * of pipe-table lines is parsed into a real <table> so nothing leaks raw
 * "| --- |" markup to the reader.
 */
function renderProse(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let table: string[] = [];
  const flushTable = (): void => {
    if (table.length === 0) return;
    const rows = table
      .filter((l) => !/^\|[\s:|-]+\|?$/.test(l.trim())) // drop the --- delimiter row
      .map((l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
    if (rows.length > 0) {
      // Normalise every row to the widest row's cell count so the <table> is
      // never ragged (reviewer P1 #2) — pad short rows, truncate long ones.
      const width = Math.max(...rows.map((r) => r.length));
      const body = rows
        .map((r) => {
          const cells = [...r];
          while (cells.length < width) cells.push("");
          return `        <tr>${cells.slice(0, width).map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`;
        })
        .join("\n");
      out.push(`      <table>\n${body}\n      </table>`);
    }
    table = [];
  };
  for (const raw of lines) {
    if (isPipeTableLine(raw)) {
      table.push(raw);
      continue;
    }
    flushTable();
    const t = raw.trim();
    if (t.length > 0) out.push(`      <p>${esc(t)}</p>`);
  }
  flushTable();
  if (out.length > 0) return out.join("\n");
  // Fallback MUST be pipe-free — never dump raw "| --- |" markup (reviewer P2 #4).
  const fb = cleanInline(stripPipeTables(text));
  return fb.length > 0 ? `      <p>${esc(fb)}</p>` : "";
}

function renderDefinition(body: DefinitionSentenceBody, input: RenderInput): string {
  const h1 = headlineOr(body.text, fallbackTitle(input, "Definition"));
  const main = composeArticle("definition", h1, `      <p>${esc(cleanInline(stripPipeTables(body.text)) || h1)}</p>`, input);
  return htmlPage(buildPageOpts({
    lang: input.language,
    canonical: input.canonicalUrl,
    datePublished: input.datePublished,
    title: h1,
    main,
    jsonLd: input.jsonLd ?? deriveJsonLd(body, input),
    disclosureTag: input.disclosureTag,
    description: metaDescription(body.text),
    home: homeOf(input),
  }));
}

function renderAnswerBlock(body: AnswerBlockBody, input: RenderInput): string {
  // Short, distinct h1 (W5.4) — never the full multi-sentence block; pipe-free (W5.1).
  const h1 = headlineOr(body.text, fallbackTitle(input, "Overview"));
  const inner = renderProse(body.text) || `      <p>${esc(h1)}</p>`;
  const main = composeArticle("answer-block", h1, inner, input);
  return htmlPage(buildPageOpts({
    lang: input.language,
    canonical: input.canonicalUrl,
    datePublished: input.datePublished,
    title: h1,
    main,
    jsonLd: input.jsonLd ?? deriveJsonLd(body, input),
    disclosureTag: input.disclosureTag,
    description: metaDescription(body.text),
    home: homeOf(input),
  }));
}

function renderFaq(body: FaqBody, input: RenderInput): string {
  const rows = body.rows
    .map(
      (row) =>
        `        <details class="faq-item">\n          <summary>${esc(row.q)}</summary>\n          <p>${esc(row.a)}</p>\n        </details>`
    )
    .join("\n");

  const h1 = body.rows[0] != null ? headlineOr(body.rows[0].q, "FAQ", 90) : "FAQ";
  // Valid markup: a <div class="faq-list"> of <details>, NOT a <dl> (W5.5).
  const main = composeArticle("faq", h1, `      <div class="faq-list">\n${rows}\n      </div>`, input);

  const title = h1;
  const desc = body.rows[0] != null ? metaDescription(`${body.rows[0].q} ${body.rows[0].a}`) : "FAQ";

  return htmlPage(buildPageOpts({
    lang: input.language,
    canonical: input.canonicalUrl,
    datePublished: input.datePublished,
    title,
    main,
    jsonLd: input.jsonLd ?? deriveJsonLd(body, input),
    disclosureTag: input.disclosureTag,
    description: desc,
    home: homeOf(input),
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

  const tableHtml = `      <table>
        <thead>
          <tr>
${headerCells}
          </tr>
        </thead>
        <tbody>
${dataRows}
        </tbody>
      </table>`;
  const h1 = body.columns.length > 0 ? body.columns.join(" vs ") : "Comparison";
  const main = composeArticle("comparison", h1, tableHtml, input);

  const title = truncateAtBoundary(h1, 70);

  return htmlPage(buildPageOpts({
    lang: input.language,
    canonical: input.canonicalUrl,
    datePublished: input.datePublished,
    title,
    main,
    jsonLd: input.jsonLd ?? deriveJsonLd(body, input),
    disclosureTag: input.disclosureTag,
    description: metaDescription(h1),
    home: homeOf(input),
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

  const inner = `      <section class="situation"><h2>Situation</h2><p>${esc(body.situation)}</p></section>
      <section class="action"><h2>Action</h2><p>${esc(body.action)}</p></section>
      <section class="result"><h2>Result</h2><p>${esc(body.result)}</p></section>${metricsTable}`;
  const h1 = headlineOr(body.situation, fallbackTitle(input, "Case study"));
  const main = composeArticle("case-study", h1, inner, input);

  const title = h1;

  return htmlPage(buildPageOpts({
    lang: input.language,
    canonical: input.canonicalUrl,
    datePublished: input.datePublished,
    title,
    main,
    jsonLd: input.jsonLd ?? deriveJsonLd(body, input),
    disclosureTag: input.disclosureTag,
    description: metaDescription([body.situation, body.action, body.result].join(" ")),
    home: homeOf(input),
  }));
}

function renderJsonLdPage(body: JsonLdBody, input: RenderInput): string {
  // For jsonld content_type, the JSON-LD IS the body's json field.
  // We render a minimal page embedding it.
  const effectiveJsonLd = body.json as JsonLd;
  const schemaType = body.schema_type;
  const title = `${schemaType} — Structured Data`;

  const main = `    <article class="jsonld-page">
      <h1>${esc(schemaType)}</h1>
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
    home: homeOf(input),
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
// renderRobots — citation-bot-friendly robots.txt (W9.1)
// ---------------------------------------------------------------------------

/**
 * AI answer-engine crawlers we explicitly welcome. Allowing these is the
 * cheapest real discovery lever: they are the bots that fetch pages to cite in
 * ChatGPT-search / Perplexity / Gemini / Claude / Google AI answers. We do NOT
 * block the general web (`User-agent: *` stays Allow) — an owned hub exists to
 * be crawled.
 */
export const ANSWER_ENGINE_BOTS: readonly string[] = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "PerplexityBot",
  "Perplexity-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "Google-Extended",
  "Applebot-Extended",
  "Amazonbot",
  "Bingbot",
  "CCBot",
];

/**
 * Render a deterministic robots.txt for an owned hub. Explicitly Allows every
 * citation bot, keeps a permissive default, and advertises the sitemap.
 * PURE — same inputs → byte-identical output.
 *
 * @param opts.sitemapUrl  Absolute sitemap URL to advertise (optional).
 */
export function renderRobots(opts: { sitemapUrl?: string }): string {
  const perBot = ANSWER_ENGINE_BOTS
    .map((ua) => `User-agent: ${ua}\nAllow: /`)
    .join("\n\n");
  const wildcard = `User-agent: *\nAllow: /`;
  const sitemap = opts.sitemapUrl ? `\n\nSitemap: ${opts.sitemapUrl}` : "";
  return `# robots.txt — AI answer-engine citation crawlers explicitly welcomed\n${perBot}\n\n${wildcard}${sitemap}\n`;
}

// ---------------------------------------------------------------------------
// renderRss — deterministic RSS 2.0 feed (W9.3) — freshness discovery lever
// ---------------------------------------------------------------------------

export interface RssItem {
  url: string;
  title: string;
  description: string;
  /** ISO-8601 publish/update instant. */
  isoDate: string;
}

/** Format an ISO-8601 instant as an RFC-822 date (RSS pubDate). Deterministic. */
function rfc822(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const mons = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return (
    `${days[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${mons[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} GMT`
  );
}

/**
 * Render a deterministic RSS 2.0 feed for an owned hub. Items are sorted
 * newest-first (then by URL for stable ties) so answer engines with a freshness
 * bias (notably Perplexity) can discover new/updated pages. PURE — same inputs →
 * byte-identical output.
 *
 * @param opts.title       Feed title (brand-scoped).
 * @param opts.homeUrl     Hub root URL (channel link).
 * @param opts.feedUrl     Absolute URL of this feed (atom:link self).
 * @param opts.language    BCP-47 language of the hub.
 * @param opts.description Feed description.
 * @param opts.items       Feed items.
 */
export function renderRss(opts: {
  title: string;
  homeUrl: string;
  feedUrl: string;
  language: string;
  description: string;
  items: RssItem[];
}): string {
  const sorted = [...opts.items].sort((a, b) =>
    a.isoDate === b.isoDate ? a.url.localeCompare(b.url) : (a.isoDate < b.isoDate ? 1 : -1)
  );
  const lastBuild = sorted.length > 0 ? rfc822(sorted[0]!.isoDate) : "";
  const items = sorted
    .map(
      (it) =>
        `    <item>\n` +
        `      <title>${esc(it.title)}</title>\n` +
        `      <link>${esc(it.url)}</link>\n` +
        `      <guid isPermaLink="true">${esc(it.url)}</guid>\n` +
        `      <pubDate>${esc(rfc822(it.isoDate))}</pubDate>\n` +
        `      <description>${esc(it.description)}</description>\n` +
        `    </item>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(opts.title)}</title>
    <link>${esc(opts.homeUrl)}</link>
    <atom:link href="${esc(opts.feedUrl)}" rel="self" type="application/rss+xml"/>
    <description>${esc(opts.description)}</description>
    <language>${esc(opts.language)}</language>${lastBuild ? `\n    <lastBuildDate>${esc(lastBuild)}</lastBuildDate>` : ""}
${items}
  </channel>
</rss>`;
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
