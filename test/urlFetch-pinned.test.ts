/**
 * test/urlFetch-pinned.test.ts — REAL coverage for defaultPinnedFetch (the
 * production IP-pinned fetch path), which the mocked SSRF suite never exercises.
 *
 * We call _fetchDeps.pinnedFetch directly against a loopback http server (the
 * SSRF guard, which would block 127.0.0.1, is intentionally bypassed here — we
 * are testing the fetch MECHANICS: the all:true lookup contract + body cap).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { _fetchDeps } from '../src/generate/urlFetch.js';

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

describe('defaultPinnedFetch (real, IP-pinned, no mock)', () => {
  it('fetches a real loopback page (proves the all:true lookup contract works)', async () => {
    const port = await listen((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('hello pinned'); });
    const resp = await _fetchDeps.pinnedFetch(`http://127.0.0.1:${port}/`, ['127.0.0.1'], {});
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('hello pinned');
  });

  it('caps the body at MAX_BODY_BYTES (1 MB) at the transport layer', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200);
      // stream ~3 MB
      const block = Buffer.alloc(256 * 1024, 0x61);
      let n = 0;
      const pump = () => {
        if (n++ >= 12) { res.end(); return; }
        if (res.write(block)) pump(); else res.once('drain', pump);
      };
      pump();
    });
    const resp = await _fetchDeps.pinnedFetch(`http://127.0.0.1:${port}/`, ['127.0.0.1'], {});
    const text = await resp.text();
    expect(text.length).toBeLessThanOrEqual(1024 * 1024);
    expect(text.length).toBeGreaterThan(0);
  });

  it('surfaces a redirect status without following it', async () => {
    const port = await listen((_req, res) => { res.writeHead(302, { Location: 'http://example.com/' }); res.end(); });
    const resp = await _fetchDeps.pinnedFetch(`http://127.0.0.1:${port}/`, ['127.0.0.1'], { redirect: 'manual' });
    expect(resp.status).toBe(302);
    expect(resp.headers.get('location')).toBe('http://example.com/');
  });
});
