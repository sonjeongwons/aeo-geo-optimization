/**
 * src/deploy/connectors/ownedNet.ts
 *
 * T07 — OwnedNetConnector: the ONLY status:'ready' connector in Phase 3.
 *
 * Implements ChannelConnector for channel_class='owned_net'.
 *
 * Key design invariants (from DESIGN-phase3.md + SPEC §0, §7#3, §7#5, §7#6):
 *
 * §0 OFF-SITE STRUCTURAL GUARANTEE:
 *   - publish() NEVER accepts a free-form URL string.
 *   - It resolves ONLY the Phase 2 deferred token {deferred:true, role:'owned_hub'}
 *     against OWNED_NET_HUB_BASE_URL from config.
 *   - The customer domain is structurally unrepresentable because the deferred token
 *     carries no host/domain info — it only carries a role tag.
 *   - DEFENSE-IN-DEPTH: fail-closed CUSTOMER_DOMAIN_BLOCKLIST guard applied inside
 *     the connector AND exposed for publishUnit to apply at dispatch level.
 *
 * OwnedNetTarget interface — the swap seam:
 *   {writePage, writeSitemap, deletePage, baseUrl}
 *   FsTarget (real today) writes to OWNED_NET_OUT_DIR.
 *   S3Target / CdnTarget slot in later with ZERO connector-interface change.
 *
 * publish() steps (DESIGN §"Owned-Net" step 1-4):
 *   1. Validate deferred token (role='owned_hub' only) and resolve base URL.
 *   2. Apply CUSTOMER_DOMAIN_BLOCKLIST guard (fail-closed before any write).
 *   3. Derive slug deterministically from assetId (safe fallback) or
 *      {industry}/{language}/{phrasing_group_id} when provided via assetMeta.
 *   4. Render HTML + JSON-LD with datePublished stamped = now().
 *   5. Write index.html + sitemap entry via OwnedNetTarget.
 *   6. Return PublishOk {publishedUrl, reversible:true, meta}.
 *
 * dryRun:true → compute plannedUrl, write nothing, return PublishDryRun.
 * unpublish()  → deletePage + remove sitemap entry.
 * confirmIndexing() → returns indexed:false (FsTarget local file is not crawlable
 *                     — NEVER 'indexed'; §7#3 / no false signal into the monitor).
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { NOT_CONFIGURED } from "../connector.js";
import type {
  ChannelConnector,
  ChannelCapability,
  PublishRequest,
  PublishResult,
  PublishOk,
  PublishDryRun,
  PublishError,
} from "../connector.js";
import type { DeferredUrl, JsonLd } from "../../content/types.js";
import { renderPage, renderSitemap } from "./render.js";
import type { SitemapEntry } from "./render.js";

// Per-brand entity identity for page JSON-LD (Organization publisher + sameAs)
// and the visible "About <brand>" blurb. Selected by the HUB_BRAND env at
// publish time — mirrors the BRANDS map in scripts/gen-hub-index.mts. sameAs
// links the official site for entity disambiguation (NOT a §0 violation — we
// LINK to the site, never scrape/represent it). Facts here are owner-attested.
const HUB_BRANDS: Record<
  string,
  { name: string; url: string; sameAs: string[]; description: string }
> = {
  emora: {
    name: "EMORA",
    url: "https://tryemora.com",
    sameAs: ["https://tryemora.com"],
    description:
      "AI character chat platform for meaningful interactions — infinite memory, image generation, and a creator economy.",
  },
  smim: {
    name: "스밈 (SMIM)",
    url: "https://smimdate.com",
    sameAs: ["https://smimdate.com"],
    description:
      "검증된 회원만 참여하는 로테이션 소개팅 서비스. 매주 금·토·일 서울에서 진행되며, 매니저가 직장·소득·신원·외모를 직접 검수합니다.",
  },
  unsanpartners: {
    name: "운산파트너스",
    url: "https://unsanpartners.kr",
    sameAs: ["https://unsanpartners.kr"],
    description:
      "28년 정비 노하우를 바탕으로 차주·영업 파트너·정비소를 연결하는 자동차 정비 중개 플랫폼. 입고·견적·수리·정산을 자동화합니다.",
  },
  sharejoa: {
    name: "쉐어조아",
    url: "https://sharejoa.kr",
    sameAs: ["https://sharejoa.kr"],
    description:
      "유튜브 프리미엄(유튜브 뮤직 프리미엄 포함)을 정가보다 할인된 가격에 1개월 단위로, 자동결제 없이 제공하는 구독 중개 서비스.",
  },
};

// ---------------------------------------------------------------------------
// OwnedNetTarget — the swap seam (FsTarget today; S3/CDN later)
// ---------------------------------------------------------------------------

/**
 * OwnedNetTarget — write/read seam for the owned-net file tree.
 *
 * This interface is the ONLY seam OwnedNetConnector calls; swapping the
 * implementation (FsTarget → S3Target → CdnTarget) requires ZERO changes
 * to the connector interface.
 */
export interface OwnedNetTarget {
  /**
   * Write a page at the given relative path (e.g. "en/my-slug/index.html").
   * Overwrites if the file already exists (overwrite-safe / idempotent).
   */
  writePage(relPath: string, content: string): Promise<void>;

  /**
   * Write (overwrite) the sitemap at sitemap.xml in the root.
   * Entries are sorted by loc for byte-identical output.
   */
  writeSitemap(entries: SitemapEntry[]): Promise<void>;

  /**
   * Delete the page at the given relative path.
   * No-op if the file does not exist (idempotent).
   */
  deletePage(relPath: string): Promise<void>;

  /**
   * The base URL for this target (e.g. "https://hub.example.com").
   * Trailing slash stripped in the constructor.
   */
  baseUrl(): string;

  /**
   * Return the local output directory path, if the target writes to the filesystem.
   * Returns null for remote targets (S3/CDN) that don't use a local outDir.
   */
  getOutDir(): string | null;
}

// ---------------------------------------------------------------------------
// FsTarget — local filesystem implementation (real today)
// ---------------------------------------------------------------------------

/**
 * FsTarget — writes the static page tree to OWNED_NET_OUT_DIR on the local
 * filesystem.  Used in Phase 3 before S3/CDN IaC is wired.
 *
 * Local files are NOT publicly crawlable, so confirmIndexing returns
 * indexed:false — indexing_status is held at 'submitted'/'unknown'.
 * NEVER 'indexed' until a real CDN target is connected (Phase 4+).
 */
export class FsTarget implements OwnedNetTarget {
  private readonly _outDir: string;
  private readonly _hubBaseUrl: string;

  constructor(outDir: string, hubBaseUrl: string) {
    // Normalise: strip trailing slash from outDir and hubBaseUrl.
    this._outDir = outDir.replace(/[/\\]+$/, "");
    this._hubBaseUrl = hubBaseUrl.replace(/\/+$/, "");
  }

  async writePage(relPath: string, content: string): Promise<void> {
    const absPath = path.join(this._outDir, relPath);
    const dir = path.dirname(absPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(absPath, content, "utf-8");
  }

  async writeSitemap(entries: SitemapEntry[]): Promise<void> {
    const xml = renderSitemap(entries);
    const absPath = path.join(this._outDir, "sitemap.xml");
    await fs.mkdir(this._outDir, { recursive: true });
    await fs.writeFile(absPath, xml, "utf-8");
  }

  async deletePage(relPath: string): Promise<void> {
    const absPath = path.join(this._outDir, relPath);
    try {
      await fs.unlink(absPath);
      // Best-effort: remove the containing directory if empty.
      const dir = path.dirname(absPath);
      await fs.rmdir(dir).catch(() => {
        /* ignore if not empty */
      });
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // Already gone — idempotent.
        return;
      }
      throw err;
    }
  }

  baseUrl(): string {
    return this._hubBaseUrl;
  }

  getOutDir(): string | null {
    return this._outDir;
  }
}

// ---------------------------------------------------------------------------
// readSitemapEntries — load existing sitemap for incremental updates
// ---------------------------------------------------------------------------

/**
 * Read the current sitemap.xml entries so we can merge/remove entries
 * without losing existing published pages.
 *
 * Returns [] if sitemap.xml does not exist yet.
 *
 * Simple regex parse (no XML library dep) — deterministic, no external deps.
 */
async function readSitemapEntries(
  outDir: string
): Promise<SitemapEntry[]> {
  const absPath = path.join(outDir, "sitemap.xml");
  let xml: string;
  try {
    xml = await fs.readFile(absPath, "utf-8");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw err;
  }

  const entries: SitemapEntry[] = [];
  const urlRe = /<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>\s*<\/url>/g;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(xml)) !== null) {
    entries.push({
      loc: m[1]!.trim(),
      lastmod: m[2]!.trim(),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Slug derivation
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic URL-safe slug from industry + language + phrasing_group_id.
 *
 * Used to construct publishedUrl from the ASSET ROW (not the deferred token —
 * the token carries no slug/industry/language).
 *
 * Fallback to assetId when industry/phrasing_group_id are absent (tests /
 * minimal stubs).
 */
export function deriveSlug(opts: {
  industry?: string | null;
  phrasingSeedOrGroupId?: string | null;
  assetId: string;
}): string {
  const { industry, phrasingSeedOrGroupId, assetId } = opts;
  if (industry && phrasingSeedOrGroupId) {
    const safe = (s: string): string =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    return `${safe(industry)}-${safe(phrasingSeedOrGroupId)}`.slice(0, 80);
  }
  // Fallback: first 8 chars of assetId (UUID, already URL-safe).
  return assetId.slice(0, 8);
}

/**
 * Build a NATURAL-LANGUAGE, URL-safe slug from a salient text field (SOTA sweep
 * proposal I). Ahrefs (1.4M prompts): natural-language URLs are cited 89.8% vs
 * 81.1% for ID-like slugs — so prefer keyword slugs over assetId.slice(0,8).
 *
 * Deterministic: same (text, assetId) → same slug. A short assetId suffix keeps
 * slugs unique across pages that begin with the same words (avoids URL clashes).
 * Falls back to the assetId prefix when `text` yields no usable keywords (e.g.
 * non-Latin scripts that strip to empty under [a-z0-9]).
 *
 * @param text     A human-readable field (question, definition key, headline…).
 * @param assetId  The asset UUID (uniqueness suffix + fallback).
 * @param maxWords Keyword cap (default 6 — concise, descriptive URLs).
 */
export function naturalLanguageSlug(
  text: string | null | undefined,
  assetId: string,
  maxWords = 6,
): string {
  const suffix = assetId.replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase();
  // §0/§7 hygiene: strip URLs/bare-domains from the text BEFORE slugging so a
  // slug can never embed a domain pulled out of the body prose.
  const cleaned = (text ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/www\.\S+/g, " ")
    .replace(/\b[a-z0-9-]+\.(?:com|net|org|io|co|ai|app|dev|kr)\b/g, " ");
  const words = cleaned
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2) // drop 1-char noise; keep meaningful tokens
    .slice(0, maxWords);

  if (words.length === 0) {
    // No Latin keywords (e.g. pure Hangul/CJK after stripping) → stable id slug.
    return assetId.slice(0, 8);
  }
  const base = words.join("-").slice(0, 60).replace(/-+$/g, "");
  return suffix ? `${base}-${suffix}` : base;
}

// ---------------------------------------------------------------------------
// §0 host guard
// ---------------------------------------------------------------------------

/**
 * assertNotBlocklisted — fail-closed host blocklist guard.
 *
 * Called INSIDE the connector (defense-in-depth) and again in publishUnit.
 * Returns a PublishError when the resolved host is on the blocklist.
 *
 * The primary §0 guarantee comes from the structural deferred-url token
 * (customer domain is unrepresentable); this is defense-in-depth.
 *
 * @param resolvedUrl   Full URL after resolving the deferred token.
 * @param blocklist     Array of lowercase host strings from CUSTOMER_DOMAIN_BLOCKLIST.
 * @returns null if safe; PublishError if blocked.
 */
export function assertNotBlocklisted(
  resolvedUrl: string,
  blocklist: readonly string[]
): PublishError | null {
  if (blocklist.length === 0) return null;
  let host: string;
  try {
    host = new URL(resolvedUrl).hostname.toLowerCase();
  } catch {
    return {
      ok: false,
      code: "BLOCKED",
      message: `Resolved URL is not a valid URL: ${resolvedUrl}`,
      retryable: false,
    };
  }
  for (const blocked of blocklist) {
    if (host === blocked || host.endsWith(`.${blocked}`)) {
      return {
        ok: false,
        code: "BLOCKED",
        message: `Resolved URL host '${host}' is on the CUSTOMER_DOMAIN_BLOCKLIST`,
        retryable: false,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deferred-token resolver
// ---------------------------------------------------------------------------

/**
 * resolveOwnedHubUrl — resolve the Phase 2 deferred token against config.
 *
 * ONLY resolves tokens with role='owned_hub'. Other roles (social_profile,
 * entity_page) belong to their respective (stubbed) channels — this connector
 * must never accept them.
 *
 * Returns null when the token is absent or not role='owned_hub', which is
 * the signal that the asset has no deferred URL to resolve for this channel.
 *
 * @param jsonLd       The JSON-LD object (or undefined).
 * @param hubBaseUrl   The configured hub base URL (from env).
 * @param lang         BCP-47 language code (derived from asset row).
 * @param slug         Deterministic slug (derived from asset row).
 * @returns Resolved URL string, or null if no deferred owned_hub token found.
 */
export function resolveOwnedHubUrl(
  jsonLd: unknown,
  hubBaseUrl: string,
  lang: string,
  slug: string
): string | null {
  if (!jsonLd || typeof jsonLd !== "object") return null;
  const obj = jsonLd as Record<string, unknown>;

  // Check url field for the deferred token.
  const url = obj["url"];
  if (isDeferredOwnedHub(url)) {
    const base = hubBaseUrl.replace(/\/+$/, "");
    const safeLang = lang.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    return `${base}/${safeLang}/${slug}/`;
  }

  // Check author/publisher url fields (Article JSON-LD).
  for (const field of ["author", "publisher"] as const) {
    const sub = obj[field];
    if (sub && typeof sub === "object") {
      const subUrl = (sub as Record<string, unknown>)["url"];
      if (isDeferredOwnedHub(subUrl)) {
        const base = hubBaseUrl.replace(/\/+$/, "");
        const safeLang = lang.toLowerCase().replace(/[^a-z0-9-]/g, "-");
        return `${base}/${safeLang}/${slug}/`;
      }
    }
  }

  return null;
}

/**
 * Type-guard: is this a DeferredUrl with role='owned_hub'?
 */
function isDeferredOwnedHub(value: unknown): value is DeferredUrl {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v["deferred"] === true && v["role"] === "owned_hub";
}

// ---------------------------------------------------------------------------
// AssetMeta — asset-row fields needed by the connector
// ---------------------------------------------------------------------------

/**
 * AssetMeta — the asset-row fields the connector needs to derive the slug
 * and build the publishedUrl.
 *
 * These are NOT carried by the deferred token (the token carries only role);
 * they MUST be supplied by the caller (publishUnit loads them from the DB row).
 */
export interface AssetMeta {
  industry: string;
  language: string;
  /** phrasing_group_id from content_asset (used as slug component). */
  phrasingSeedOrGroupId: string;
}

// ---------------------------------------------------------------------------
// stampDatePublished — stamp datePublished on an Article JSON-LD
// ---------------------------------------------------------------------------

/**
 * Stamp datePublished on a JSON-LD object at publish time.
 *
 * Phase 2 emits Article JSON-LD with datePublished: null (before Phase 3
 * IaC stamps the real publish date). Phase 3 replaces null with the ISO-8601
 * publish timestamp.
 *
 * Returns the input unchanged for non-Article types.
 *
 * Uses 'unknown' cast chain to avoid the type incompatibility between
 * ArticleJsonLd (datePublished: null) and the stamped form (datePublished: string).
 * This is intentional: the stamped form is NOT a valid Phase 2 ArticleJsonLd,
 * it is the Phase 3 artifact with the date filled in.
 */
export function stampDatePublished(jsonLd: JsonLd, datePublished: string): JsonLd {
  if (jsonLd["@type"] === "Article") {
    // Spread to avoid mutating the original; cast through unknown to bridge
    // the Phase 2 (datePublished:null) → Phase 3 (datePublished:string) gap.
    const stamped = { ...jsonLd, datePublished } as unknown as JsonLd;
    return stamped;
  }
  return jsonLd;
}

// ---------------------------------------------------------------------------
// OwnedNetConnector
// ---------------------------------------------------------------------------

/**
 * OwnedNetConnector — the ONLY status:'ready' ChannelConnector in Phase 3.
 *
 * Capabilities: ['publish', 'update', 'unpublish', 'confirm_indexing'].
 * No channel API key required; no cloud creds; pure file writes via OwnedNetTarget.
 *
 * STRUCTURAL §0:
 *   publish() resolves the deferred token {deferred:true, role:'owned_hub'}
 *   against OWNED_NET_HUB_BASE_URL.  A free-form URL is NEVER accepted.
 *   If no owned_hub token is present in the JSON-LD, publish() builds the URL
 *   directly from hubBaseUrl + lang + slug (still from config, never free-form).
 *
 * DRY-RUN:
 *   When req.dryRun is true, publish() computes plannedUrl and returns
 *   PublishDryRun without writing any file. Dry-runs never consume budget or
 *   strand queue rows.
 *
 * CONFIRM_INDEXING:
 *   Returns indexed:false always (FsTarget local file is NOT crawlable).
 *   indexing_status is 'submitted'/'unknown' only — NEVER 'indexed' for FsTarget.
 */
export class OwnedNetConnector implements ChannelConnector {
  readonly channelClass = "owned_net" as const;
  readonly capabilities: ChannelCapability[] = [
    "publish",
    "update",
    "unpublish",
    "confirm_indexing",
  ];
  readonly status = "ready" as const;

  private readonly _target: OwnedNetTarget;
  private readonly _hubBaseUrl: string;
  private readonly _blocklist: readonly string[];

  /**
   * @param target       OwnedNetTarget impl (FsTarget today; injectable for testing).
   * @param hubBaseUrl   OWNED_NET_HUB_BASE_URL — required for real publishes.
   * @param blocklist    CUSTOMER_DOMAIN_BLOCKLIST — fail-closed guard (§0).
   */
  constructor(
    target: OwnedNetTarget,
    hubBaseUrl: string,
    blocklist: readonly string[] = []
  ) {
    this._target = target;
    this._hubBaseUrl = hubBaseUrl.replace(/\/+$/, "");
    this._blocklist = blocklist.map((h) => h.toLowerCase());
  }

  // -------------------------------------------------------------------------
  // publish()
  // -------------------------------------------------------------------------

  async publish(req: PublishRequest): Promise<PublishResult> {
    const lang = req.language;

    // Derive slug from body metadata or assetId fallback.
    const slug = this._deriveSlugFromRequest(req);

    // Build the planned URL from config (NEVER from a free-form string in req).
    const plannedUrl = `${this._hubBaseUrl}/${lang.toLowerCase()}/${slug}/`;

    // §0 DEFENSE-IN-DEPTH: blocklist check BEFORE any write.
    const blockErr = assertNotBlocklisted(plannedUrl, this._blocklist);
    if (blockErr) return blockErr;

    // DRY-RUN: compute URL, write nothing.
    if (req.dryRun) {
      const dryResult: PublishDryRun = {
        ok: true,
        dryRun: true,
        plannedUrl,
      };
      return dryResult;
    }

    // Stamp datePublished = now (ISO-8601).
    const now = new Date();
    const datePublished = now.toISOString();

    // Stamp datePublished into JSON-LD if present (Article type).
    const jsonLd: JsonLd | undefined =
      req.jsonLd !== undefined
        ? stampDatePublished(req.jsonLd, datePublished)
        : undefined;

    // Render deterministic HTML. Brand identity (for JSON-LD Organization +
    // entity blurb — the AEO/GEO entity-disambiguation lever) is selected by the
    // HUB_BRAND env, mirroring the hub index generator; omitted when unset.
    const brand = HUB_BRANDS[(process.env["HUB_BRAND"] ?? "").toLowerCase()];
    const renderInput = {
      body: req.body,
      disclosureTag: req.disclosureTag,
      canonicalUrl: plannedUrl,
      language: lang,
      datePublished,
      ...(jsonLd !== undefined ? { jsonLd } : {}),
      ...(brand ? { brand } : {}),
    };
    const html = renderPage(renderInput);

    // Write index.html.
    const relPagePath = `${lang.toLowerCase()}/${slug}/index.html`;
    await this._target.writePage(relPagePath, html);

    // Update sitemap — merge with existing entries.
    const outDir = this._target.getOutDir();
    const existing = outDir != null ? await readSitemapEntries(outDir) : [];
    // Full W3C datetime (not date-only) so a same-day material republish changes
    // <lastmod> and matches the on-page datePublished/dateModified (W9.4).
    const updated = _mergeSitemapEntry(existing, {
      loc: plannedUrl,
      lastmod: datePublished,
    });
    await this._target.writeSitemap(updated);

    const okResult: PublishOk = {
      ok: true,
      publishedUrl: plannedUrl,
      reversible: true,
      meta: {
        outPath: relPagePath,
        hubBaseUrl: this._hubBaseUrl,
        datePublished,
      },
    };
    return okResult;
  }

  // -------------------------------------------------------------------------
  // unpublish()
  // -------------------------------------------------------------------------

  async unpublish(externalRef: string): Promise<PublishResult> {
    // externalRef = the relPagePath written at publish time
    // (stored in url_registry.publish_meta.outPath).
    try {
      await this._target.deletePage(externalRef);

      // Remove from sitemap.
      const outDir = this._target.getOutDir();
      if (outDir != null) {
        const existing = await readSitemapEntries(outDir);
        // We don't know the exact loc here (externalRef is a file path),
        // so we remove any entry whose loc path contains the slug directory.
        const slugDir = path.dirname(externalRef).replace(/\\/g, "/"); // e.g. "en/my-slug"
        const filtered = existing.filter(
          (e) => !e.loc.includes(`/${slugDir}/`)
        );
        if (filtered.length !== existing.length) {
          await this._target.writeSitemap(filtered);
        }
      }

      const result: PublishOk = {
        ok: true,
        publishedUrl: externalRef,
        reversible: true,
        meta: { action: "unpublished", outPath: externalRef },
      };
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const errResult: PublishError = {
        ok: false,
        code: "UNPUBLISH_ERROR",
        message: msg,
        retryable: true,
      };
      return errResult;
    }
  }

  // -------------------------------------------------------------------------
  // confirmIndexing()
  // -------------------------------------------------------------------------

  /**
   * FsTarget local file is NOT publicly crawlable.
   * Returns indexed:false — indexing_status is held at 'submitted'/'unknown',
   * NEVER 'indexed', until a real CDN target is connected (Phase 4+).
   *
   * §7#3: no false signal into the Phase 0 monitor.
   */
  async confirmIndexing(
    _publishedUrl: string
  ): Promise<{ indexed: boolean; checkedAt: Date }> {
    return { indexed: false, checkedAt: new Date() };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Derive a URL-safe slug from the publish request.
   * Uses body metadata (meaning_key for definitions) or assetId as fallback.
   * The canonical approach for the full industry/phrasing slug is via assetMeta
   * passed by publishUnit — but since PublishRequest doesn't carry those fields
   * today, we use the most stable available key: the assetId prefix.
   */
  private _deriveSlugFromRequest(req: PublishRequest): string {
    // Pick the most salient human-readable text per content_type, then build a
    // NATURAL-LANGUAGE slug from it (SOTA sweep I — keyword URLs cite better).
    // Deterministic + unique (assetId suffix); falls back to the assetId prefix
    // when no Latin keywords are available.
    const body = req.body;
    const salient = ((): string | null => {
      switch (body.content_type) {
        case "definition":
          // meaning_key is a stable semantic key; fall back to the definition text.
          return body.meaning_key || body.text || null;
        case "answer_block":
          return body.text || null;
        case "faq":
          // First question is the most query-like, slug-worthy text.
          return body.rows[0]?.q || null;
        case "comparison":
          // "X vs Y" — the compared columns are the keyword-rich subject.
          return body.columns.join(" vs ") || null;
        case "case_study":
          return body.situation || null;
        default:
          return null; // jsonld / unknown → id slug
      }
    })();

    return naturalLanguageSlug(salient, req.assetId);
  }
}

// ---------------------------------------------------------------------------
// Module-level helper (avoids private member access issues)
// ---------------------------------------------------------------------------

/**
 * Merge a new sitemap entry, replacing any existing entry with the same loc.
 */
function _mergeSitemapEntry(
  existing: SitemapEntry[],
  entry: SitemapEntry
): SitemapEntry[] {
  const without = existing.filter((e) => e.loc !== entry.loc);
  return [...without, entry];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * makeOwnedNetConnector — build the OwnedNetConnector with FsTarget.
 *
 * Called by buildConnectorRegistry() in registry.ts (T06).
 *
 * @param outDir      OWNED_NET_OUT_DIR from env.
 * @param hubBaseUrl  OWNED_NET_HUB_BASE_URL from env.  May be undefined when
 *                    only dry-run publishes are expected — the connector is
 *                    still created (so dry-run works) but real publishes will
 *                    produce empty publishedUrls.
 * @param blocklist   CUSTOMER_DOMAIN_BLOCKLIST from env (§0 defense-in-depth).
 */
export function makeOwnedNetConnector(
  outDir: string,
  hubBaseUrl: string | undefined,
  blocklist: readonly string[] = []
): OwnedNetConnector {
  const base = hubBaseUrl ?? "";
  const target = new FsTarget(outDir, base);
  return new OwnedNetConnector(target, base, blocklist);
}

// ---------------------------------------------------------------------------
// NOT_CONFIGURED re-export (for connectors that need it)
// ---------------------------------------------------------------------------

export { NOT_CONFIGURED };
