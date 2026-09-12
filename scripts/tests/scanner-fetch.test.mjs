import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedScanUrl, readBoundedText, safeFetch } from '../../src/lib/scanner-fetch.ts';

test('rejects internal literals, credentials and nonstandard ports', () => {
  for (const url of ['http://127.1','http://[::1]','http://[::ffff:7f00:1]','http://localhost.','http://foo.localhost','http://10.1.2.3','http://169.254.169.254','https://user:pass@example.com','https://example.com:8080']) {
    assert.equal(isAllowedScanUrl(new URL(url)), false, url);
  }
  assert.equal(isAllowedScanUrl(new URL('https://example.com/')), true);
});

test('cancels oversized chunked bodies without buffering them all', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5)); c.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedText(body, 6), /size limit/);
  assert.equal(cancelled, true);
});

test('does not follow a public redirect to a private destination', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(init.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/' } });
  };
  try {
    assert.deepEqual(await safeFetch('https://example.com'), { ok: false, text: '', status: 302 });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('follows a normal HTTPS canonical redirect and reads the page', async () => {
  const originalFetch = globalThis.fetch;
  const visited = [];
  globalThis.fetch = async (url) => {
    visited.push(String(url));
    return visited.length === 1
      ? new Response(null, { status: 301, headers: { location: 'https://www.example.com/' } })
      : new Response('<title>Example</title>', { status: 200 });
  };
  try {
    assert.deepEqual(await safeFetch('https://example.com'), { ok: true, text: '<title>Example</title>', status: 200 });
    assert.deepEqual(visited, ['https://example.com/', 'https://www.example.com/']);
  } finally { globalThis.fetch = originalFetch; }
});

test('caps public redirect loops at four requests', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: '/again' } });
  };
  try {
    assert.equal((await safeFetch('https://example.com')).ok, false);
    assert.equal(calls, 4);
  } finally { globalThis.fetch = originalFetch; }
});
