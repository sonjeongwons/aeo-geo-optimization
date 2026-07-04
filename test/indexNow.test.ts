/**
 * test/indexNow.test.ts — IndexNow submission (W9.2).
 *
 * Locks the honest, off-by-default behavior: no network call without a key, a
 * deterministic submission body, and a same-host keyLocation.
 */
import { describe, it, expect } from "vitest";
import {
  indexNowKeyFile,
  buildIndexNowSubmission,
  submitIndexNow,
} from "../src/deploy/indexNow.js";

describe("indexNowKeyFile", () => {
  it("names the file <key>.txt containing the key", () => {
    expect(indexNowKeyFile("abc123")).toEqual({ filename: "abc123.txt", content: "abc123" });
  });
});

describe("buildIndexNowSubmission", () => {
  const sub = buildIndexNowSubmission({
    hubBaseUrl: "https://acme.github.io/aeo-hub/",
    key: "k9",
    urls: ["https://acme.github.io/aeo-hub/en/b/", "https://acme.github.io/aeo-hub/en/a/", "https://acme.github.io/aeo-hub/en/a/"],
  });
  it("derives host + a same-host keyLocation", () => {
    expect(sub.host).toBe("acme.github.io");
    expect(sub.keyLocation).toBe("https://acme.github.io/aeo-hub/k9.txt");
  });
  it("de-duplicates + sorts urlList (deterministic)", () => {
    expect(sub.urlList).toEqual([
      "https://acme.github.io/aeo-hub/en/a/",
      "https://acme.github.io/aeo-hub/en/b/",
    ]);
  });
});

describe("submitIndexNow", () => {
  it("is a no-op (skipped) when no key is set", async () => {
    const res = await submitIndexNow({ hubBaseUrl: "https://h/", urls: ["https://h/a/"], key: undefined });
    expect("skipped" in res).toBe(true);
  });

  it("skips when there are no URLs", async () => {
    const res = await submitIndexNow({ hubBaseUrl: "https://h/", urls: [], key: "k" });
    expect(res).toEqual({ skipped: "no URLs to submit" });
  });

  it("POSTs the submission when a key is provided (injected fetch)", async () => {
    let captured: { url: string; body: string } | null = null;
    const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      captured = { url, body: init.body };
      return { status: 200 };
    };
    const res = await submitIndexNow({
      hubBaseUrl: "https://acme.github.io/aeo-hub/",
      urls: ["https://acme.github.io/aeo-hub/en/a/"],
      key: "k9",
      fetchImpl,
    });
    expect(res).toEqual({ submitted: 1, status: 200 });
    expect(captured!.url).toBe("https://api.indexnow.org/indexnow");
    const body = JSON.parse(captured!.body);
    expect(body.host).toBe("acme.github.io");
    expect(body.key).toBe("k9");
    expect(body.urlList).toHaveLength(1);
  });
});
