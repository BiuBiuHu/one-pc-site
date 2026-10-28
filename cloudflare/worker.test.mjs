import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import worker from './worker.mjs';

const env = { DEPLOY_ENV: 'preview', GH_BRANCH: 'test-content', GH_TOKEN: 'test-token', WRITE_PASSWORD: 'test-password' };
const req = (path, data, method = data ? 'POST' : 'GET') => new Request('https://preview.example' + path, {
  method, ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
});
const call = (path, data, settings = env) => worker.fetch(req(path, data), settings);
async function mocked(fetcher, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { await run(); } finally { globalThis.fetch = original; }
}
const content = (text, sha = 'file-sha') => Response.json({ content: Buffer.from(text).toString('base64'), sha });

test('health is native, unknown APIs remain 404 and API responses are uncached', async () => {
  await mocked(() => { throw Error('no origin allowed'); }, async () => {
    const r = await call('/api/health');
    assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal((await call('/api/missing')).status, 404);
    assert.equal((await call('/_vercel/insights/view')).status, 204);
  });
});

test('preview cannot write to main, including when its branch binding is missing', async () => {
  await mocked(() => { throw Error('no write allowed'); }, async () => {
    for (const GH_BRANCH of ['main', undefined]) {
      const r = await call('/api/comments', { slug: 'test', body: 'comment' }, { ...env, GH_BRANCH });
      assert.equal(r.status, 403);
    }
  });
});

test('auth fails closed for absent bindings and wrong passwords before provider calls', async () => {
  await mocked(() => { throw Error('not authenticated'); }, async () => {
    assert.equal((await call('/api/post', { title: 'test', body: 'test' }, { DEPLOY_ENV: 'production' })).status, 503);
    assert.equal((await call('/api/list?password=wrong')).status, 401);
    assert.equal((await call('/api/delete', { password: 'wrong', slug: 'x', sha: 'x' })).status, 401);
  });
});

test('UTF-8 article reads target the selected branch and keep the existing response shape', async () => {
  await mocked(async (url, init) => {
    assert.match(String(url), /ref=test-content/); assert.equal(init.headers.Authorization, 'Bearer test-token');
    return content('---\ntitle: 中文标题\ndate: 2026-10-28\n---\n\n日本語正文\n');
  }, async () => {
    const r = await call('/api/get?slug=test&password=test-password'); const body = await r.json();
    assert.equal(r.status, 200); assert.equal(body.title, '中文标题'); assert.equal(body.body, '日本語正文'); assert.equal(body.sha, 'file-sha');
  });
});

test('list uses the isolated directory and raw branch and returns metadata', async () => {
  await mocked(async (url) => {
    if (String(url).startsWith('https://api.github.com')) { assert.match(String(url), /ref=test-content/); return Response.json([{ name: 'test.md', sha: 'x' }]); }
    assert.match(String(url), /\/test-content\//); return new Response('---\ntitle: 测试\ndate: 2026-10-28\n---\n正文');
  }, async () => {
    const r = await call('/api/list?password=test-password'); const data = await r.json(); assert.equal(data.items[0].title, '测试');
  });
});

test('article create/update/delete preserve branch, UTF-8 content and optimistic SHA', async () => {
  const writes = [];
  await mocked(async (url, init) => {
    const body = JSON.parse(init.body); writes.push({ url, method: init.method, body });
    assert.equal(body.branch, 'test-content');
    return Response.json({ content: { sha: 'new-sha' } });
  }, async () => {
    const created = await (await call('/api/post', { password: 'test-password', title: '标题', body: '正文' })).json();
    assert.equal(created.sha, 'new-sha'); assert.match(Buffer.from(writes[0].body.content, 'base64').toString(), /正文/);
    const updated = await call('/api/post', { password: 'test-password', title: '改', body: '新正文', slug: created.slug, sha: 'old-sha' });
    assert.equal(updated.status, 200); assert.equal(writes[1].body.sha, 'old-sha');
    const removed = await call('/api/delete', { password: 'test-password', slug: created.slug, sha: 'new-sha' });
    assert.equal(removed.status, 200); assert.equal(writes[2].method, 'DELETE'); assert.equal(writes[2].body.sha, 'new-sha');
  });
});

test('article paths reject traversal before writing', async () => {
  await mocked(() => { throw Error('no provider call'); }, async () => {
    assert.equal((await call('/api/get?slug=../comments&password=test-password')).status, 400);
    assert.equal((await call('/api/post', { password: 'test-password', title: 'x', body: 'x', slug: '../comments', sha: 'x' })).status, 400);
  });
});

test('comment writes retry a conflicting snapshot without losing other comments', async () => {
  let reads = 0, writes = 0;
  await mocked(async (url, init) => {
    if (!init.method) {
      reads++; return content(JSON.stringify({ test: reads === 1 ? [] : [{ body: 'concurrent comment' }] }), 'sha-' + reads);
    }
    writes++; const payload = JSON.parse(init.body);
    assert.equal(payload.branch, 'test-content'); assert.equal(payload.sha, 'sha-' + reads);
    const stored = JSON.parse(Buffer.from(payload.content, 'base64').toString());
    if (writes === 2) { assert.equal(stored.test.length, 2); assert.equal(stored.test[0].body, 'concurrent comment'); }
    return new Response(null, { status: writes === 1 ? 409 : 200 });
  }, async () => {
    const r = await call('/api/comments', { slug: 'test', name: '测试', body: 'new comment' });
    assert.equal(r.status, 200); assert.equal((await r.json()).comments.length, 2); assert.equal(reads, 2);
  });
});

test('comment read failure never overwrites existing data with an empty store', async () => {
  let writes = 0;
  await mocked(async (url, init) => { if (init.method) writes++; return new Response('denied', { status: 403 }); }, async () => {
    assert.equal((await call('/api/comments', { slug: 'test', body: 'x' })).status, 502); assert.equal(writes, 0);
  });
});

test('secrets are request-scoped rather than shared across environments', async () => {
  await mocked(async () => Response.json([]), async () => {
    const [a, b] = await Promise.all([
      call('/api/list?password=test-password'),
      call('/api/list?password=test-password', undefined, { ...env, WRITE_PASSWORD: 'other-password' }),
    ]); assert.equal(a.status, 200); assert.equal(b.status, 401);
  });
});

test('malformed and oversized request bodies are rejected', async () => {
  const invalid = await worker.fetch(new Request('https://preview.example/api/post', { method: 'POST', body: '{' }), env);
  assert.equal(invalid.status, 400);
  const large = await worker.fetch(new Request('https://preview.example/api/post', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) }), env);
  assert.equal(large.status, 413);
});

test('missing pages use the static 404 and never fetch Vercel', async () => {
  const r = await worker.fetch(req('/missing'), { ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } });
  assert.equal(r.status, 404);
});
