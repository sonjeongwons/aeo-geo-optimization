/**
 * src/generate/urlFetch.ts
 *
 * UrlFetcher seam — GET-ONLY by construction (no POST/PUT/PATCH/DELETE exists
 * in this module; §0 "never modify the customer site" is STRUCTURAL).
 *
 * Controls (DESIGN-phase1.md § URL Diagnosis):
 *  - http(s)-only scheme allowlist
 *  - SSRF guard: resolves host ONCE, validates ALL returned A/AAAA addresses,
 *    then PINs the connection via a custom node:http/https Agent whose lookup
 *    callback returns ONLY the pre-validated addresses (no second OS resolve).
 *    Blocked ranges: 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16,
 *    0.0.0.0/8, 100.64.0.0/10 (CGNAT), ::1, fc00::/7, fe80::/10,
 *    :: unspecified, IPv4-mapped IPv6 (::ffff:x.x.x.x decoded+re-checked)
 *  - Re-run resolve-validate-pin on EACH redirect hop
 *  - robots.txt check uses redirect:"manual" (SSRF-02 fix: no per-hop bypass)
 *  - AbortController 8 s timeout
 *  - Max-body ~1 MB (truncate stream)
 *  - Descriptive User-Agent
 *  - Redirect follow ≤3, same-registrable-domain only
 *  - Best-effort robots.txt / X-Robots-Tag noai check (record reason, no
 *    hard-fail — degrades to industry-only in the caller)
 *
 * Returns {ok, finalUrl, html, contentType, robotsNote?}
 *       | {ok:false, reason}
 *
 * IP-Pinning fallback (undici not installed as standalone dep):
 *   Uses node:http / node:https Agent with a custom `lookup` callback that
 *   returns ONLY the pre-validated IP addresses from the single resolve step.
 *   The Host / SNI header is set to the original hostname so virtual-hosting
 *   and TLS certificate validation work correctly.
 *
 *   Test seam: `_fetchDeps.pinnedFetch` is the mutable hook used in tests.
 *   Because ESM named exports are read-only from the outside, we expose the
 *   injectable function through a plain mutable object (`_fetchDeps`) whose
 *   property tests can replace via direct mutation or vi.mock factory.
 */

import { promises as dnsPromises } from "node:dns";
import * as nodeHttp from "node:http";
import * as nodeHttps from "node:https";
import type { LookupFunction } from "node:net";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 1_024 * 1_024; // 1 MB
const MAX_REDIRECTS = 3;
const USER_AGENT =
  "AEO-GEO-Bot/1.0 (+https://github.com/aeo-geo-optimization; diagnosis-only; read-only)";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface FetchOk {
  ok: true;
  finalUrl: string;
  html: string;
  contentType: string;
  /** Non-empty when a robots/noai directive was detected but did NOT hard-fail. */
  robotsNote?: string;
}

export interface FetchFailed {
  ok: false;
  reason: string;
}

export type FetchResult = FetchOk | FetchFailed;

// ---------------------------------------------------------------------------
// SSRF guard helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the dotted-decimal IPv4 string falls in a private /
 * link-local / metadata / reserved range.
 *
 * Blocked ranges:
 *   0.0.0.0/8      — "this" network; 0.0.0.0 routes to localhost on Linux
 *   127.0.0.0/8    — loopback
 *   10.0.0.0/8     — RFC 1918 class A
 *   100.64.0.0/10  — CGNAT shared address space (RFC 6598)
 *   172.16.0.0/12  — RFC 1918 class B
 *   192.168.0.0/16 — RFC 1918 class C
 *   169.254.0.0/16 — link-local / AWS metadata (169.254.169.254)
 */
export function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false; // not a valid IPv4; let DNS resolution decide
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true;                            // 0.0.0.0/8 unspecified / "this" network
  if (a === 127) return true;                          // 127/8 loopback
  if (a === 10) return true;                           // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16/12
  if (a === 192 && b === 168) return true;             // 192.168/16
  if (a === 169 && b === 254) return true;             // 169.254/16 link-local + metadata

  return false;
}

/**
 * Returns true when the IPv6 address string should be blocked.
 *
 * Blocked:
 *   ::              — unspecified address
 *   ::1             — loopback
 *   fc00::/7        — Unique Local Addresses (fc00:: … fdff::)
 *   fe80::/10       — link-local IPv6
 *   ::ffff:0:0/96   — IPv4-mapped IPv6; embedded IPv4 is re-checked via isBlockedIPv4
 *
 * IPv4-mapped detection: ::ffff:x.x.x.x where the embedded address is blocked
 * covers ::ffff:127.0.0.1, ::ffff:169.254.169.254, etc.
 */
export function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");

  // :: unspecified address
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;

  // ::1 loopback (various representations)
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;

  // IPv4-mapped IPv6: ::ffff:a.b.c.d  or  ::ffff:0:0/96 forms
  // Canonical form: "::ffff:a.b.c.d"
  const mappedV4Match = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedV4Match) {
    const embedded = mappedV4Match[1];
    if (embedded !== undefined && isBlockedIPv4(embedded)) return true;
  }
  // Hex form of mapped: ::ffff:7f00:1 = ::ffff:127.0.0.1, etc.
  // Normalise: if it starts with "::ffff:" and the remainder is two hex groups (no dots), decode
  const mappedHexMatch = lower.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
  if (mappedHexMatch) {
    const hi = parseInt(mappedHexMatch[1] ?? "0", 16);
    const lo = parseInt(mappedHexMatch[2] ?? "0", 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >> 8) & 0xff;
    const d = lo & 0xff;
    if (isBlockedIPv4(`${a}.${b}.${c}.${d}`)) return true;
  }

  // fe80::/10 — link-local IPv6
  // First 10 bits are 1111 1110 10; first two bytes: 0xFE 0x80–0xBF
  const firstGroup = lower.split(":")[0] ?? "";
  if (firstGroup.length >= 3) {
    const firstTwoBytes = parseInt(firstGroup.slice(0, 4).padStart(4, "0"), 16);
    if (!isNaN(firstTwoBytes)) {
      const byte0 = (firstTwoBytes >> 8) & 0xff;
      const byte1 = firstTwoBytes & 0xff;
      if (byte0 === 0xfe && byte1 >= 0x80 && byte1 <= 0xbf) return true;
    }
  }

  // fc00::/7 — Unique Local Addresses (fc00:: … fdff::)
  if (firstGroup.length >= 2) {
    const firstByte = parseInt(firstGroup.slice(0, 2), 16);
    if (!isNaN(firstByte) && (firstByte === 0xfc || firstByte === 0xfd)) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve all A/AAAA records for a hostname and return the validated list.
 * Throws with a descriptive SSRF_BLOCKED message if ANY resolved IP is private.
 *
 * For raw IP hostnames, validates directly without a DNS call and returns the
 * singleton list.
 *
 * Returns the list of validated addresses so the caller can pin the connection.
 */
async function resolveAndValidate(hostname: string): Promise<string[]> {
  // If the hostname is already a raw IPv4 literal, check it directly.
  if (/^[\d.]+$/.test(hostname)) {
    if (isBlockedIPv4(hostname)) {
      throw new Error(`SSRF_BLOCKED: ${hostname} is in a private/reserved IPv4 range`);
    }
    return [hostname];
  }

  // Raw IPv6 literal (with or without brackets).
  if (hostname.startsWith("[") || hostname.includes(":")) {
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (isBlockedIPv6(bare)) {
      throw new Error(`SSRF_BLOCKED: ${hostname} is in a blocked IPv6 range`);
    }
    return [bare];
  }

  // DNS resolution — check every returned address.
  let addresses: string[] = [];
  try {
    const records = await dnsPromises.resolve(hostname);
    addresses = records;
  } catch {
    // Also try resolve4 / resolve6 individually.
    try {
      addresses = await dnsPromises.resolve4(hostname);
    } catch {
      addresses = [];
    }
    try {
      const v6 = await dnsPromises.resolve6(hostname);
      addresses.push(...v6);
    } catch {
      // ignore
    }
  }

  // Fail CLOSED: a host that resolves to nothing must NOT fall through to a
  // 0.0.0.0 / localhost connection. (Also the validation loop below would be
  // skipped on an empty list, so an empty set is never safe to pass on.)
  if (addresses.length === 0) {
    throw new Error(`SSRF_BLOCKED: ${hostname} did not resolve to any address`);
  }

  for (const addr of addresses) {
    if (isBlockedIPv4(addr)) {
      throw new Error(`SSRF_BLOCKED: ${hostname} resolves to private IPv4 ${addr}`);
    }
    if (isBlockedIPv6(addr)) {
      throw new Error(`SSRF_BLOCKED: ${hostname} resolves to blocked IPv6 ${addr}`);
    }
  }

  return addresses;
}

// ---------------------------------------------------------------------------
// IP-pinned fetch (test-injectable via _fetchDeps)
// ---------------------------------------------------------------------------

/** Signature for the pinned-fetch implementation. */
export type PinnedFetchFn = (
  url: string,
  validatedAddresses: string[],
  init: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: string }
) => Promise<Response>;

/**
 * Mutable dependency container for test injection.
 *
 * ESM named exports are read-only from outside the module, so we expose the
 * injectable fetch through a plain object property that tests can overwrite:
 *
 *   import { _fetchDeps } from "../src/generate/urlFetch.js";
 *   beforeEach(() => { _fetchDeps.pinnedFetch = myMock; });
 */
export const _fetchDeps: { pinnedFetch: PinnedFetchFn } = {
  pinnedFetch: defaultPinnedFetch,
};

/**
 * Build a fetch-compatible Response using node:http / node:https with a custom
 * Agent whose `lookup` callback returns ONLY the pre-validated IP addresses.
 * This prevents the OS from performing a second DNS lookup at connect time
 * (closing the DNS-rebinding / TOCTOU window).
 *
 * The Host header and TLS SNI are set to the original hostname so virtual
 * hosting and certificate validation work correctly.
 */
async function defaultPinnedFetch(
  url: string,
  validatedAddresses: string[],
  init: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: string }
): Promise<Response> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const port = parsed.port
    ? parseInt(parsed.port, 10)
    : isHttps ? 443 : 80;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const path = parsed.pathname + parsed.search;

  // Build a custom lookup that returns ONLY the pre-validated addresses, so the
  // OS never performs a second DNS resolution at connect time (closes the
  // DNS-rebinding / TOCTOU window). node:http/https invokes lookup with
  // { all: true } and REQUIRES an ARRAY of { address, family }; the single-string
  // form throws "Invalid IP address: undefined". We honor BOTH call styles.
  const pinned = validatedAddresses.map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 }));
  const lookupFn: LookupFunction = ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
    if (opts && opts.all) {
      cb(null, pinned);
    } else {
      const first = pinned[0]!;
      cb(null, first.address, first.family);
    }
  }) as unknown as LookupFunction;

  const reqHeaders: Record<string, string> = {
    "User-Agent": init.headers?.["User-Agent"] ?? USER_AGENT,
    Host: parsed.host, // preserve original Host for virtual hosting
    ...init.headers,
  };

  return new Promise<Response>((resolve, reject) => {
    const reqOptions: nodeHttps.RequestOptions = {
      hostname,
      port,
      path,
      method: "GET",
      headers: reqHeaders,
      lookup: lookupFn,
      // For HTTPS: set servername for SNI
      ...(isHttps ? { servername: parsed.hostname.replace(/^\[|\]$/g, "") } : {}),
    };

    const makeReq = isHttps ? nodeHttps.request : nodeHttp.request;

    // Hook AbortSignal
    let req: nodeHttp.ClientRequest | undefined;
    if (init.signal) {
      if (init.signal.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      init.signal.addEventListener("abort", () => {
        req?.destroy(new DOMException("The operation was aborted.", "AbortError") as unknown as Error);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      }, { once: true });
    }

    req = makeReq(reqOptions, (res) => {
      const status = res.statusCode ?? 0;
      const statusText = res.statusMessage ?? "";
      const rawHeaders = res.headers;

      // Build a minimal Headers object
      const headers = new Headers();
      for (const [k, v] of Object.entries(rawHeaders)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const val of v) headers.append(k, val);
        } else {
          headers.set(k, v);
        }
      }

      if (status >= 300 && status < 400) {
        // Return a redirect-like Response so caller's redirect logic takes over
        res.resume(); // drain body
        resolve({
          ok: false,
          status,
          statusText,
          headers,
          redirected: false,
          type: "basic",
          url,
          body: null,
          bodyUsed: true,
          clone: () => { throw new Error("not cloneable"); },
          arrayBuffer: async () => new ArrayBuffer(0),
          blob: async () => new Blob([]),
          json: async () => null,
          text: async () => "",
          bytes: async () => new Uint8Array(0),
          formData: async () => { throw new Error("not implemented"); },
        } as unknown as Response);
        return;
      }

      // Stream body, enforcing MAX_BODY_BYTES at the TRANSPORT layer so a
      // malicious/large server cannot exhaust memory before the outer cap reads it.
      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const bodyBuf = Buffer.concat(chunks);
        const bodyBytes = new Uint8Array(bodyBuf.buffer, bodyBuf.byteOffset, bodyBuf.byteLength);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bodyBytes);
            controller.close();
          },
        });
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText,
          headers,
          redirected: false,
          type: "basic",
          url,
          body: stream,
          bodyUsed: false,
          clone: () => { throw new Error("not cloneable"); },
          arrayBuffer: async () => bodyBuf.buffer,
          blob: async () => new Blob([bodyBytes]),
          json: async () => JSON.parse(bodyBuf.toString("utf8")),
          text: async () => bodyBuf.toString("utf8"),
          bytes: async () => bodyBytes,
          formData: async () => { throw new Error("not implemented"); },
        } as unknown as Response);
      };
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_BODY_BYTES) {
          // Truncate to the cap, stop reading from the socket, and settle.
          const keep = MAX_BODY_BYTES - (received - chunk.length);
          if (keep > 0) chunks.push(chunk.subarray(0, keep));
          res.destroy();
          finish();
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", finish);
      res.on("close", finish); // covers the res.destroy() truncation path
      res.on("error", (err: Error) => { if (!settled) reject(err); });
    });

    req.on("error", (err) => {
      if (err instanceof DOMException && err.name === "AbortError") {
        reject(err);
      } else {
        reject(err);
      }
    });

    req.end();
  });
}

// ---------------------------------------------------------------------------
// Registrable-domain helper (minimal, no external dep)
// ---------------------------------------------------------------------------

/**
 * Very lightweight "same registrable domain" check.
 * Returns the last two labels of a hostname (e.g. "google.com" from
 * "www.google.com").  Good enough for <=3-redirect detection; a full PSL
 * library would be needed for ccTLD second-levels (co.uk etc.) but that is
 * beyond the scope of this module.
 */
function registrableDomain(hostname: string): string {
  const labels = hostname.replace(/^\[|\]$/g, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  return labels.slice(-2).join(".");
}

// ---------------------------------------------------------------------------
// robots.txt / X-Robots-Tag check (best-effort, no hard-fail)
// ---------------------------------------------------------------------------

/**
 * Attempt to fetch robots.txt for the given origin and check for Disallow
 * targeting our User-Agent or * for the given path.
 *
 * Uses redirect:"manual" (SSRF-02 fix) — if robots.txt redirects we treat it
 * as "no robots info" rather than following the redirect through an unguarded
 * path. A robots.txt redirect to a private host is simply ignored.
 *
 * The request is made via _fetchDeps.pinnedFetch so the connection is pinned
 * to the already-validated IPs (preventing DNS rebinding on the robots fetch).
 *
 * Returns a human-readable note if we are disallowed, or undefined if clear.
 * Errors are swallowed — this is best-effort.
 */
async function checkRobotsTxt(
  origin: string,
  path: string,
  validatedAddresses: string[],
  signal: AbortSignal
): Promise<string | undefined> {
  try {
    const robotsUrl = `${origin}/robots.txt`;
    // redirect:"manual" means any redirect is treated as "no robots info".
    const resp = await _fetchDeps.pinnedFetch(robotsUrl, validatedAddresses, {
      signal,
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
    });

    // A redirect (3xx) from robots.txt is treated as "no info" — do not follow.
    if (resp.status >= 300 && resp.status < 400) return undefined;
    if (!resp.ok) return undefined;

    const text = await resp.text();
    const lines = text.split(/\r?\n/);
    let applicable = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (/^user-agent\s*:/i.test(line)) {
        const agent = line.replace(/^user-agent\s*:\s*/i, "").trim().toLowerCase();
        applicable = agent === "*" || agent === "aeo-geo-bot";
      }
      if (applicable && /^disallow\s*:/i.test(line)) {
        const disallowed = line.replace(/^disallow\s*:\s*/i, "").trim();
        if (disallowed === "/" || path.startsWith(disallowed)) {
          return `robots.txt disallows path "${disallowed}" for our User-Agent`;
        }
      }
    }
  } catch {
    // best-effort; ignore errors
  }
  return undefined;
}

/**
 * Check the X-Robots-Tag response header for noai/noindex directives.
 * Returns a note string if any relevant directive is present, else undefined.
 */
function checkXRobotsTag(headers: Headers): string | undefined {
  const tag = headers.get("x-robots-tag");
  if (!tag) return undefined;
  const lower = tag.toLowerCase();
  if (lower.includes("noai") || lower.includes("noimageai")) {
    return `X-Robots-Tag: ${tag} (noai directive present)`;
  }
  if (lower.includes("noindex") || lower.includes("none")) {
    return `X-Robots-Tag: ${tag} (noindex/none directive present)`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the given URL for read-only diagnosis.
 *
 * This function is GET-ONLY by construction — no POST/PUT/PATCH/DELETE
 * code path exists anywhere in this module.
 *
 * @param rawUrl - The URL to fetch (must be http or https).
 * @returns FetchResult
 */
export async function urlFetch(rawUrl: string): Promise<FetchResult> {
  // ---- 1. Scheme allowlist -------------------------------------------------
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Invalid URL: ${rawUrl}` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `Scheme "${parsed.protocol}" is not allowed; only http and https are permitted`,
    };
  }

  // ---- 2. SSRF guard: resolve ONCE, validate ALL addresses, get pinned IPs --
  let validatedAddresses: string[];
  try {
    validatedAddresses = await resolveAndValidate(parsed.hostname);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg };
  }

  // ---- 3. robots.txt best-effort check (redirect:manual — SSRF-02 fix) -----
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const origin = `${parsed.protocol}//${parsed.host}`;
  const robotsNote = await checkRobotsTxt(
    origin,
    parsed.pathname || "/",
    validatedAddresses,
    controller.signal
  );

  // ---- 4. Main fetch with redirect tracking (IP-pinned — SSRF-01 fix) ------
  let redirectCount = 0;
  let currentUrl = rawUrl;
  const startDomain = registrableDomain(parsed.hostname);
  let currentValidatedAddresses = validatedAddresses;

  let response: Response;
  try {
    // We handle redirects manually so we can enforce the same-domain + count caps.
    // Each hop uses pinnedFetch with addresses validated for THAT hop's hostname.
    response = await _fetchDeps.pinnedFetch(currentUrl, currentValidatedAddresses, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
    });

    // Follow up to MAX_REDIRECTS redirects
    while (
      response.status >= 300 &&
      response.status < 400 &&
      redirectCount < MAX_REDIRECTS
    ) {
      const location = response.headers.get("location");
      if (!location) break;

      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        return { ok: false, reason: `Invalid redirect location: ${location}` };
      }

      // Scheme check on redirect target
      if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
        return {
          ok: false,
          reason: `Redirect target scheme "${nextUrl.protocol}" is not allowed`,
        };
      }

      // Same registrable domain check
      const nextDomain = registrableDomain(nextUrl.hostname);
      if (nextDomain !== startDomain) {
        return {
          ok: false,
          reason: `Cross-domain redirect blocked: "${startDomain}" → "${nextDomain}"`,
        };
      }

      // SSRF guard on redirect target — re-resolve+re-validate+re-pin for this hop
      try {
        currentValidatedAddresses = await resolveAndValidate(nextUrl.hostname);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, reason: msg };
      }

      redirectCount++;
      currentUrl = nextUrl.toString();

      response = await _fetchDeps.pinnedFetch(currentUrl, currentValidatedAddresses, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
        redirect: "manual",
      });
    }

    if (response.status >= 300 && response.status < 400) {
      return { ok: false, reason: `Too many redirects (>${MAX_REDIRECTS})` };
    }

    if (!response.ok) {
      return {
        ok: false,
        reason: `HTTP ${response.status} ${response.statusText} for ${currentUrl}`,
      };
    }
  } catch (e: unknown) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, reason: `Fetch timed out after ${TIMEOUT_MS}ms` };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `Fetch error: ${msg}` };
  } finally {
    clearTimeout(timer);
  }

  // ---- 5. X-Robots-Tag check -----------------------------------------------
  const xRobotsNote = checkXRobotsTag(response.headers);
  const combinedRobotsNote = [robotsNote, xRobotsNote].filter(Boolean).join("; ") || undefined;

  // ---- 6. Body with byte cap -----------------------------------------------
  const contentType = response.headers.get("content-type") ?? "text/html";
  let html: string;
  try {
    const reader = response.body?.getReader();
    if (!reader) {
      return { ok: false, reason: "Response body is not readable" };
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let done = false;

    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (result.value) {
        const remaining = MAX_BODY_BYTES - totalBytes;
        if (result.value.byteLength >= remaining) {
          // Take only up to the cap and stop reading
          chunks.push(result.value.slice(0, remaining));
          totalBytes += remaining;
          await reader.cancel();
          break;
        }
        chunks.push(result.value);
        totalBytes += result.value.byteLength;
      }
    }

    // Decode the collected chunks
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    html = new TextDecoder().decode(merged);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `Body read error: ${msg}` };
  }

  return {
    ok: true,
    finalUrl: currentUrl,
    html,
    contentType,
    ...(combinedRobotsNote ? { robotsNote: combinedRobotsNote } : {}),
  };
}
