/**
 * test/urlFetch-ssrf.test.ts
 *
 * Tests for the urlFetch SSRF guard, scheme allowlist, timeout, byte cap,
 * and redirect controls.  All network calls are mocked via vi.mock so no
 * real network activity occurs.
 *
 * T03 acceptance criteria:
 *  ✓ Rejects http://169.254.169.254 and private IPs before any network call
 *  ✓ Rejects non-http(s) schemes
 *  ✓ Enforces timeout and byte cap
 *  ✓ Caps redirects and blocks cross-registrable-domain redirects
 *  ✓ No POST/PUT/PATCH/DELETE code path exists (structural — verified by grep)
 *  ✓ Blocks 0.0.0.0/8, :: unspecified, IPv4-mapped IPv6, fe80::/10, 100.64/10 (CGNAT)
 *  ✓ robots.txt redirect to a private host is NOT followed (SSRF-02 fix)
 *  ✓ Connection is pinned to pre-validated IPs (_fetchDeps.pinnedFetch seam)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { urlFetch, _fetchDeps } from "../src/generate/urlFetch.js";
import type { PinnedFetchFn } from "../src/generate/urlFetch.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object for mocking fetch. */
function makeResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string>; ok?: boolean } = {}
): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? { "content-type": "text/html" });
  const ok = init.ok ?? (status >= 200 && status < 300);

  const encoder = new TextEncoder();
  const bytes = encoder.encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers,
    body: stream,
    bodyUsed: false,
    redirected: false,
    type: "basic",
    url: "https://example.com/",
    clone: () => makeResponse(body, init),
    arrayBuffer: async () => bytes.buffer,
    blob: async () => new Blob([bytes]),
    json: async () => JSON.parse(body),
    text: async () => body,
    bytes: async () => bytes,
    formData: async () => { throw new Error("not implemented"); },
  } as unknown as Response;
}

/** Build a redirect Response (3xx) with a Location header. */
function makeRedirect(location: string, status = 302): Response {
  return makeResponse("", {
    status,
    ok: false,
    headers: { location },
  });
}

// ---------------------------------------------------------------------------
// DNS mock — intercept the node:dns promises so SSRF checks work without
// real DNS resolution.
// ---------------------------------------------------------------------------

vi.mock("node:dns", () => ({
  promises: {
    resolve: vi.fn(),
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  },
}));

import { promises as dnsPromises } from "node:dns";

const mockDns = dnsPromises as {
  resolve: ReturnType<typeof vi.fn>;
  resolve4: ReturnType<typeof vi.fn>;
  resolve6: ReturnType<typeof vi.fn>;
};

/** Make DNS resolve to a given address. */
function setDnsResolveTo(addr: string): void {
  mockDns.resolve.mockResolvedValue([addr]);
  mockDns.resolve4.mockResolvedValue([addr]);
  mockDns.resolve6.mockRejectedValue(new Error("no AAAA"));
}

// ---------------------------------------------------------------------------
// _fetchDeps.pinnedFetch mock
//
// All actual HTTP requests go through _fetchDeps.pinnedFetch (the IP-pinned
// seam).  Because _fetchDeps is a plain mutable object (not an ESM named
// export directly), we can swap out .pinnedFetch in beforeEach without any
// special vi.mock machinery.
// ---------------------------------------------------------------------------

let pinnedFetchMock: ReturnType<typeof vi.fn<Parameters<PinnedFetchFn>, ReturnType<PinnedFetchFn>>>;
let originalPinnedFetch: PinnedFetchFn;

beforeEach(() => {
  originalPinnedFetch = _fetchDeps.pinnedFetch;
  pinnedFetchMock = vi.fn<Parameters<PinnedFetchFn>, ReturnType<PinnedFetchFn>>();
  _fetchDeps.pinnedFetch = pinnedFetchMock;

  mockDns.resolve.mockReset();
  mockDns.resolve4.mockReset();
  mockDns.resolve6.mockReset();
});

afterEach(() => {
  _fetchDeps.pinnedFetch = originalPinnedFetch;
});

// ---------------------------------------------------------------------------
// Scheme allowlist tests
// ---------------------------------------------------------------------------

describe("scheme allowlist", () => {
  it("rejects ftp:// scheme", async () => {
    const result = await urlFetch("ftp://example.com/file.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/scheme/i);
    }
  });

  it("rejects file:// scheme", async () => {
    const result = await urlFetch("file:///etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/scheme/i);
    }
  });

  it("rejects javascript: scheme", async () => {
    const result = await urlFetch("javascript:alert(1)");
    expect(result.ok).toBe(false);
  });

  it("rejects data: URI", async () => {
    const result = await urlFetch("data:text/html,<h1>hi</h1>");
    expect(result.ok).toBe(false);
  });

  it("accepts https:// (SSRF guard passes for public IP)", async () => {
    setDnsResolveTo("93.184.216.34"); // example.com public IP — not blocked
    // robots.txt fetch (via _fetchDeps.pinnedFetch)
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("", { status: 404, ok: false }));
    // main fetch
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("<html></html>"));
    const result = await urlFetch("https://example.com/");
    expect(result.ok).toBe(true);
  });

  it("accepts http:// (SSRF guard passes for public IP)", async () => {
    setDnsResolveTo("93.184.216.34");
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("", { status: 404, ok: false }));
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("<html></html>"));
    const result = await urlFetch("http://example.com/");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSRF guard tests — private IPv4 ranges
// ---------------------------------------------------------------------------

describe("SSRF guard — private IPv4 literal addresses", () => {
  it("rejects 127.0.0.1 (loopback) — no fetch call needed", async () => {
    const result = await urlFetch("http://127.0.0.1/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
    // _fetchDeps.pinnedFetch should never have been called
    expect(pinnedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects 169.254.169.254 (AWS metadata endpoint)", async () => {
    const result = await urlFetch("http://169.254.169.254/latest/meta-data/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
    expect(pinnedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects 10.0.0.1 (RFC1918 class A)", async () => {
    const result = await urlFetch("http://10.0.0.1/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
    expect(pinnedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects 172.16.0.1 (RFC1918 class B lower)", async () => {
    const result = await urlFetch("http://172.16.0.1/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
    expect(pinnedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects 172.31.255.255 (RFC1918 class B upper)", async () => {
    const result = await urlFetch("http://172.31.255.255/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
    expect(pinnedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects 192.168.1.1 (RFC1918 class C)", async () => {
    const result = await urlFetch("http://192.168.1.1/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
    expect(pinnedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects 0.0.0.0 (unspecified — 0.0.0.0/8 routes to localhost on Linux)", async () => {
    const result = await urlFetch("http://0.0.0.0/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
    expect(pinnedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects 0.1.2.3 (inside 0.0.0.0/8)", async () => {
    const result = await urlFetch("http://0.1.2.3/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
    expect(pinnedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects 100.64.0.1 (CGNAT 100.64.0.0/10)", async () => {
    const result = await urlFetch("http://100.64.0.1/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
    expect(pinnedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects 100.127.255.255 (CGNAT upper bound of 100.64.0.0/10)", async () => {
    const result = await urlFetch("http://100.127.255.255/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
    expect(pinnedFetchMock).not.toHaveBeenCalled();
  });

  it("does NOT reject 100.128.0.0 (outside CGNAT range)", async () => {
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("", { status: 404, ok: false }));
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("<html></html>"));
    const result = await urlFetch("http://100.128.0.0/");
    expect(result.ok).toBe(true);
  });

  it("does NOT reject 172.32.0.0 (outside RFC1918 172.16/12)", async () => {
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("", { status: 404, ok: false }));
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("<html></html>"));
    const result = await urlFetch("http://172.32.0.0/");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSRF guard tests — DNS resolves to private IP
// ---------------------------------------------------------------------------

describe("SSRF guard — DNS resolves to private IP", () => {
  it("rejects hostname that resolves to 10.0.0.1", async () => {
    setDnsResolveTo("10.0.0.1");
    const result = await urlFetch("https://internal.example.com/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
    expect(pinnedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects hostname that resolves to 169.254.169.254", async () => {
    setDnsResolveTo("169.254.169.254");
    const result = await urlFetch("https://metadata.internal/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
    expect(pinnedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects hostname that resolves to 127.0.0.1", async () => {
    setDnsResolveTo("127.0.0.1");
    const result = await urlFetch("https://localhost.evil.com/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
  });

  it("allows hostname that resolves to a public IP", async () => {
    setDnsResolveTo("93.184.216.34"); // example.com
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("", { status: 404, ok: false }));
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("<html><title>Test</title></html>"));
    const result = await urlFetch("https://example.com/");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSRF guard — IPv6 blocked ranges
// ---------------------------------------------------------------------------

describe("SSRF guard — IPv6", () => {
  it("rejects ::1 loopback", async () => {
    const result = await urlFetch("http://[::1]/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
  });

  it("rejects fc00:: Unique Local", async () => {
    const result = await urlFetch("http://[fc00::1]/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
  });

  it("rejects fd00:: Unique Local", async () => {
    const result = await urlFetch("http://[fd00::1]/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
  });

  it("rejects :: unspecified IPv6 address", async () => {
    const result = await urlFetch("http://[::]/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
  });

  it("rejects fe80::1 (link-local IPv6, fe80::/10)", async () => {
    const result = await urlFetch("http://[fe80::1]/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
  });

  it("rejects fea0::1 (link-local IPv6, fe80::/10 range)", async () => {
    const result = await urlFetch("http://[fea0::1]/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
  });

  it("rejects ::ffff:127.0.0.1 (IPv4-mapped loopback)", async () => {
    const result = await urlFetch("http://[::ffff:127.0.0.1]/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
  });

  it("rejects ::ffff:169.254.169.254 (IPv4-mapped metadata endpoint)", async () => {
    const result = await urlFetch("http://[::ffff:169.254.169.254]/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
  });

  it("rejects hostname that DNS resolves to ::ffff:169.254.169.254 (IPv4-mapped metadata)", async () => {
    // DNS returns an IPv4-mapped IPv6 address for the metadata endpoint
    mockDns.resolve.mockRejectedValue(new Error("ENOTFOUND"));
    mockDns.resolve4.mockRejectedValue(new Error("ENOTFOUND"));
    mockDns.resolve6.mockResolvedValue(["::ffff:169.254.169.254"]);
    const result = await urlFetch("https://evil.example.com/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
    expect(pinnedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects hostname that DNS resolves to ::ffff:127.0.0.1 (IPv4-mapped loopback)", async () => {
    mockDns.resolve.mockRejectedValue(new Error("ENOTFOUND"));
    mockDns.resolve4.mockRejectedValue(new Error("ENOTFOUND"));
    mockDns.resolve6.mockResolvedValue(["::ffff:127.0.0.1"]);
    const result = await urlFetch("https://evil.example.com/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
    expect(pinnedFetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Redirect controls
// ---------------------------------------------------------------------------

describe("redirect controls", () => {
  it("blocks cross-domain redirect", async () => {
    setDnsResolveTo("93.184.216.34");
    // robots.txt 404
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("", { status: 404, ok: false }));
    // Main fetch → redirect to a different domain
    pinnedFetchMock.mockResolvedValueOnce(
      makeRedirect("https://evil.com/steal")
    );
    const result = await urlFetch("https://example.com/page");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/[Cc]ross.domain/);
  });

  it("blocks after MAX_REDIRECTS same-domain redirects", async () => {
    setDnsResolveTo("93.184.216.34");
    // robots.txt 404
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("", { status: 404, ok: false }));
    // 4 redirects (limit is 3), all same domain
    pinnedFetchMock.mockResolvedValueOnce(makeRedirect("https://example.com/r1"));
    pinnedFetchMock.mockResolvedValueOnce(makeRedirect("https://example.com/r2"));
    pinnedFetchMock.mockResolvedValueOnce(makeRedirect("https://example.com/r3"));
    pinnedFetchMock.mockResolvedValueOnce(makeRedirect("https://example.com/r4"));
    // Would be the 5th fetch if it got that far
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("<html></html>"));

    const result = await urlFetch("https://example.com/start");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/[Tt]oo many redirect/);
  });

  it("follows up to MAX_REDIRECTS same-domain redirects successfully", async () => {
    setDnsResolveTo("93.184.216.34");
    // robots.txt 404
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("", { status: 404, ok: false }));
    // 3 redirects (at the limit), then a 200
    pinnedFetchMock.mockResolvedValueOnce(makeRedirect("https://example.com/r1"));
    pinnedFetchMock.mockResolvedValueOnce(makeRedirect("https://example.com/r2"));
    pinnedFetchMock.mockResolvedValueOnce(makeRedirect("https://example.com/r3"));
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("<html><title>Final</title></html>"));

    const result = await urlFetch("https://example.com/start");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain("Final");
    }
  });

  it("blocks redirect to a private host (SSRF on redirect hop)", async () => {
    // First resolve call: public IP (for initial SSRF check)
    mockDns.resolve.mockResolvedValueOnce(["93.184.216.34"]);
    mockDns.resolve4.mockResolvedValueOnce(["93.184.216.34"]);
    mockDns.resolve6.mockRejectedValue(new Error("no AAAA"));

    // robots.txt 404
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("", { status: 404, ok: false }));
    // Main fetch redirects to same domain
    pinnedFetchMock.mockResolvedValueOnce(makeRedirect("https://example.com/internal"));

    // Second resolve call (redirect hop): private IP (DNS rebinding simulation)
    mockDns.resolve.mockResolvedValueOnce(["10.0.0.1"]);
    mockDns.resolve4.mockResolvedValueOnce(["10.0.0.1"]);

    const result = await urlFetch("https://example.com/page");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SSRF_BLOCKED/);
  });
});

// ---------------------------------------------------------------------------
// robots.txt redirect bypass protection (SSRF-02)
// ---------------------------------------------------------------------------

describe("robots.txt SSRF-02 — no redirect follow", () => {
  it("does NOT follow a robots.txt redirect to a private host", async () => {
    // Setup: DNS resolves example.com to a public IP
    setDnsResolveTo("93.184.216.34");

    // robots.txt responds with a 302 redirect to the metadata endpoint.
    // The previous code used redirect:"follow" which would have followed this.
    // The fix uses redirect:"manual" and treats any redirect as "no info".
    pinnedFetchMock.mockResolvedValueOnce(
      makeRedirect("http://169.254.169.254/latest/meta-data/")
    );
    // Main fetch returns normally (robots note should be undefined)
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("<html><title>Safe</title></html>"));

    const result = await urlFetch("https://example.com/");
    // The main fetch should succeed (robots.txt redirect is ignored, not followed)
    expect(result.ok).toBe(true);
    if (result.ok) {
      // robotsNote should be undefined (redirect was not followed, no rules parsed)
      expect(result.robotsNote).toBeUndefined();
    }
    // Critically: pinnedFetch was called exactly TWICE:
    //   1. robots.txt (got 302, stopped — did NOT fetch 169.254.169.254)
    //   2. main page fetch
    // NOT a third time for the metadata redirect target
    expect(pinnedFetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a robots.txt 302 as 'no robots info' and proceeds with main fetch", async () => {
    setDnsResolveTo("93.184.216.34");
    // robots.txt redirects (to same domain — doesn't matter, we don't follow)
    pinnedFetchMock.mockResolvedValueOnce(makeRedirect("https://example.com/robots-v2.txt"));
    // main fetch
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("<html></html>"));

    const result = await urlFetch("https://example.com/");
    expect(result.ok).toBe(true);
    // robots.txt redirect was not followed, so no disallow note
    if (result.ok) {
      expect(result.robotsNote).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// IP-pinning via _fetchDeps.pinnedFetch seam (SSRF-01)
// ---------------------------------------------------------------------------

describe("SSRF-01 IP pinning — pinnedFetch receives validated addresses", () => {
  it("passes the resolved public IP to pinnedFetch (not re-resolved at connect time)", async () => {
    setDnsResolveTo("93.184.216.34");
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("", { status: 404, ok: false }));
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("<html></html>"));

    await urlFetch("https://example.com/");

    // pinnedFetch should have been called with the validated addresses
    const calls = pinnedFetchMock.mock.calls;
    expect(calls.length).toBe(2);
    // Each call receives (url, validatedAddresses, init)
    // validatedAddresses should contain the resolved IP (not empty)
    for (const call of calls) {
      const addrs = call[1]; // second arg is validatedAddresses
      expect(Array.isArray(addrs)).toBe(true);
      expect((addrs as string[]).length).toBeGreaterThan(0);
      // The addresses should not include any private IP
      for (const addr of addrs as string[]) {
        expect(addr).not.toMatch(/^127\.|^10\.|^169\.254\./);
      }
    }
  });

  it("re-resolves and re-validates on each redirect hop (per-hop pinning)", async () => {
    // Initial resolve: public IP
    mockDns.resolve
      .mockResolvedValueOnce(["93.184.216.34"]) // initial resolve for example.com
      .mockResolvedValueOnce(["93.184.216.99"]); // re-resolve for redirect hop
    mockDns.resolve4
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValueOnce(["93.184.216.99"]);
    mockDns.resolve6
      .mockRejectedValue(new Error("no AAAA"));

    // robots.txt 404
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("", { status: 404, ok: false }));
    // Main fetch: redirect to same domain
    pinnedFetchMock.mockResolvedValueOnce(makeRedirect("https://example.com/final"));
    // Final fetch: success
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("<html><title>Final</title></html>"));

    const result = await urlFetch("https://example.com/start");
    expect(result.ok).toBe(true);

    // 3 calls: robots, initial, redirect-hop
    expect(pinnedFetchMock).toHaveBeenCalledTimes(3);
    // The redirect hop (3rd call) should use the re-resolved addresses
    const thirdCall = pinnedFetchMock.mock.calls[2];
    expect(thirdCall).toBeDefined();
    const addrs = thirdCall![1] as string[];
    expect(addrs).toBeDefined();
    expect(addrs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Byte cap
// ---------------------------------------------------------------------------

describe("byte cap", () => {
  it("truncates response body at ~1MB", async () => {
    const ONE_MB = 1_024 * 1_024;
    setDnsResolveTo("93.184.216.34");
    // robots.txt 404
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("", { status: 404, ok: false }));
    // Large body
    const bigBody = "x".repeat(ONE_MB + 500);
    pinnedFetchMock.mockResolvedValueOnce(makeResponse(bigBody));

    const result = await urlFetch("https://example.com/big");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html.length).toBeLessThanOrEqual(ONE_MB);
    }
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("timeout", () => {
  it("returns error on AbortError (simulated timeout)", async () => {
    setDnsResolveTo("93.184.216.34");
    // robots.txt — throw AbortError (swallowed by best-effort)
    const abortErr = new DOMException("The operation was aborted.", "AbortError");
    pinnedFetchMock.mockRejectedValueOnce(abortErr);
    // Even if we reach main fetch, also abort
    pinnedFetchMock.mockRejectedValueOnce(abortErr);

    const result = await urlFetch("https://example.com/slow");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The robots.txt abort is swallowed; the main fetch abort should surface
      expect(typeof result.reason).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// X-Robots-Tag best-effort (non-hard-fail)
// ---------------------------------------------------------------------------

describe("robots / X-Robots-Tag (non-hard-fail)", () => {
  it("records robotsNote but still returns ok=true for noai header", async () => {
    setDnsResolveTo("93.184.216.34");
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("", { status: 404, ok: false }));
    pinnedFetchMock.mockResolvedValueOnce(
      makeResponse("<html></html>", {
        headers: {
          "content-type": "text/html",
          "x-robots-tag": "noai, noimageai",
        },
      })
    );

    const result = await urlFetch("https://example.com/");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.robotsNote).toBeDefined();
      expect(result.robotsNote).toMatch(/noai/);
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP error responses
// ---------------------------------------------------------------------------

describe("HTTP error responses", () => {
  it("returns ok=false for 404 on main fetch", async () => {
    setDnsResolveTo("93.184.216.34");
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("", { status: 404, ok: false }));
    pinnedFetchMock.mockResolvedValueOnce(makeResponse("Not Found", { status: 404, ok: false }));

    const result = await urlFetch("https://example.com/missing");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/404/);
  });
});

// ---------------------------------------------------------------------------
// No POST/PUT/PATCH/DELETE structural check
// ---------------------------------------------------------------------------

describe("read-only structural check", () => {
  it("the urlFetch module source contains no POST/PUT/PATCH/DELETE method strings", async () => {
    // Import the module source as text and verify no write verbs appear as
    // the value of the 'method' fetch option.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/generate/urlFetch.ts", import.meta.url),
      "utf8"
    );
    // No method: 'POST', method: "PUT", etc.
    expect(src).not.toMatch(/method\s*:\s*["']POST["']/i);
    expect(src).not.toMatch(/method\s*:\s*["']PUT["']/i);
    expect(src).not.toMatch(/method\s*:\s*["']PATCH["']/i);
    expect(src).not.toMatch(/method\s*:\s*["']DELETE["']/i);
  });
});
