import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const [base, mode, secretFile, outputFile] = process.argv.slice(2);
assert.ok(base && ['preview', 'production'].includes(mode) && secretFile && outputFile, 'Pass base URL, preview/production, private secret JSON and report path');
if (mode === 'preview') assert.match(new URL(base).hostname, /^peak-lake-blog-preview\..*\.workers\.dev$/, 'Writes require the dedicated preview hostname');
const secrets = JSON.parse(await readFile(secretFile, 'utf8'));
assert.ok(secrets.WRITE_PASSWORD, 'Missing private test credential');
const records = [];
async function call(label, path, data, expected = 200) {
  const r = await fetch(new URL(path, base), { method: data ? 'POST' : 'GET', headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(30000) });
  records.push({ label, status: r.status, provider: r.headers.get('x-hosting-provider') });
  assert.equal(r.status, expected, label);
  return r.json();
}
await call('native health', '/api/health');
await call('wrong password', '/api/list?password=invalid', undefined, 401);
const list = await call('authenticated list', '/api/list?password=' + encodeURIComponent(secrets.WRITE_PASSWORD));
assert.ok(list.items.length > 0, 'Existing article list');
const first = list.items[0].slug;
const article = await call('authenticated article', '/api/get?slug=' + encodeURIComponent(first) + '&password=' + encodeURIComponent(secrets.WRITE_PASSWORD));
assert.ok(article.body && article.sha, 'Existing article body and SHA');
await call('public comments', '/api/comments?slug=' + encodeURIComponent(first));
let productionWrites = 0;
if (mode === 'preview') {
  const created = await call('create isolated article', '/api/post', { password: secrets.WRITE_PASSWORD, title: 'Cloudflare 隔离验证', body: '中文与日本語の本文' });
  const read = await call('read isolated article', '/api/get?slug=' + created.slug + '&password=' + encodeURIComponent(secrets.WRITE_PASSWORD));
  assert.ok(read.body.includes('日本語'), 'UTF-8 preserved');
  const updated = await call('update isolated article', '/api/post', { password: secrets.WRITE_PASSWORD, title: '隔离更新', body: '更新正文', slug: created.slug, sha: read.sha });
  assert.notEqual(updated.sha, read.sha);
  await call('append isolated comment', '/api/comments', { slug: created.slug, name: 'migration test', body: '隔离评论' });
  const comments = await call('read isolated comment', '/api/comments?slug=' + created.slug); assert.equal(comments.comments.length, 1);
  await call('delete isolated article', '/api/delete', { password: secrets.WRITE_PASSWORD, slug: created.slug, sha: updated.sha });
  await call('deleted article gone', '/api/get?slug=' + created.slug + '&password=' + encodeURIComponent(secrets.WRITE_PASSWORD), undefined, 404);
} else {
  // Fail before any GitHub write; exercise production routing/auth without creating content.
  await call('post requires content', '/api/post', { password: secrets.WRITE_PASSWORD }, 400);
  await call('delete requires slug/SHA', '/api/delete', { password: secrets.WRITE_PASSWORD }, 400);
  await call('comment requires content', '/api/comments', {}, 400);
}
await writeFile(outputFile, JSON.stringify({ timestampUTC: new Date().toISOString(), base, mode, records, productionWrites }, null, 2) + '\n');
console.log(JSON.stringify({ mode, checks: records.length, productionWrites }));
