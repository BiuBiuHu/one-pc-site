import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

test('API proxy preserves method, query, authentication and body, without caching', async () => {
  const originalFetch = globalThis.fetch;
  const original = new Request('https://preview.example/api/post?draft=1', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'session=test' },
    body: JSON.stringify({ title: 'Test', body: 'Content' }),
  });
  let calls = 0;
  globalThis.fetch = async (request, options) => {
    calls++;
    assert.equal(request.url, 'https://origin.example/api/post?draft=1');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('cookie'), 'session=test');
    assert.deepEqual(await request.json(), { title: 'Test', body: 'Content' });
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cf.cacheTtl, 0);
    return Response.json({ ok: true }, { status: 201 });
  };
  try {
    const response = await worker.fetch(original, { LEGACY_ORIGIN: 'https://origin.example' });
    assert.equal(calls, 1);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { ok: true });
  } finally { globalThis.fetch = originalFetch; }
});

test('preview refuses writes before contacting the live backend', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Must not contact production'); };
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await worker.fetch(new Request('https://preview.example/api/comments', { method }), {
        READ_ONLY_ORIGIN: 'true', LEGACY_ORIGIN: 'https://origin.example',
      });
      assert.equal(response.status, 403);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('missing pages remain 404 and never fall back to the origin homepage', async () => {
  let requests = 0;
  const response = await worker.fetch(new Request('https://preview.example/missing'), {
    ASSETS: { fetch: async () => { requests++; return new Response('Not found', { status: 404 }); } },
  });
  assert.equal(response.status, 404);
  assert.equal(requests, 1);
});
