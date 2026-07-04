/**
 * src/deploy/indexNow.ts
 *
 * IndexNow submission (roadmap W9.2) — the most direct discovery accelerant for
 * Bing / ChatGPT-search (which indexes via Bing). On publish/republish we POST
 * the changed URLs to api.indexnow.org so the owned hub is crawled sooner.
 *
 * §7 HONESTY: IndexNow SUBMITS a URL for crawling — it does NOT guarantee (or
 * mean) the URL is indexed or cited. All logging/framing says "submitted", never
 * "indexed". OFF BY DEFAULT: no network call happens unless INDEXNOW_KEY is set
 * (the owner opts in). The pure builders below are always safe.
 *
 * Node 22 ESM NodeNext — global fetch; relative imports use .js extension.
 */

/** The key-verification file IndexNow fetches to confirm ownership. */
export function indexNowKeyFile(key: string): { filename: string; content: string } {
  return { filename: `${key}.txt`, content: key };
}

export interface IndexNowSubmission {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
}

/**
 * Build a deterministic IndexNow submission body. PURE. urlList is de-duplicated
 * and sorted so the same page set always produces byte-identical output. The key
 * file must be served at keyLocation on the same host as the URLs.
 */
export function buildIndexNowSubmission(opts: {
  hubBaseUrl: string;
  key: string;
  urls: string[];
}): IndexNowSubmission {
  const host = new URL(opts.hubBaseUrl).host;
  const base = opts.hubBaseUrl.replace(/\/+$/, "");
  return {
    host,
    key: opts.key,
    keyLocation: `${base}/${opts.key}.txt`,
    urlList: [...new Set(opts.urls)].sort(),
  };
}

export type IndexNowResult =
  | { submitted: number; status: number }
  | { skipped: string };

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ status: number }>;

/**
 * Submit the given hub URLs to IndexNow. No-op (returns {skipped}) unless a key
 * is provided or INDEXNOW_KEY is set — so importing/calling this is always safe.
 *
 * @param opts.hubBaseUrl  Hub root (e.g. https://host/repo/).
 * @param opts.urls        Absolute page URLs that changed (or the full set).
 * @param opts.key         Override; falls back to process.env.INDEXNOW_KEY.
 * @param opts.fetchImpl   Injected for tests; defaults to global fetch.
 */
export async function submitIndexNow(opts: {
  hubBaseUrl: string;
  urls: string[];
  key?: string;
  fetchImpl?: FetchLike;
}): Promise<IndexNowResult> {
  const key = opts.key ?? process.env["INDEXNOW_KEY"];
  if (!key) return { skipped: "INDEXNOW_KEY not set — not submitted" };
  if (opts.urls.length === 0) return { skipped: "no URLs to submit" };

  const body = buildIndexNowSubmission({ hubBaseUrl: opts.hubBaseUrl, key, urls: opts.urls });
  const f: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const res = await f("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return { submitted: body.urlList.length, status: res.status };
}
