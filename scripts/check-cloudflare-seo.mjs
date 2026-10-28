import assert from 'node:assert/strict';
const base = process.argv[2];
const target = process.argv[3] || 'preview';
const results = [];
for (const path of ['/', '/en/', '/ja/', '/blog/mcp-model-context-protocol', '/en/blog/mcp-model-context-protocol', '/ja/blog/loop-engineering', '/write']) {
  const r = await fetch(new URL(path, base));
  const text = await r.text();
  assert.equal(r.status, 200, path);
  assert.match(text, /<link rel="canonical" href="https:\/\/www\.peak-lake\.com\//);
  assert.match(text, /hreflang="(?:zh-CN|en-US|ja-JP)"/);
  assert.match(text, /<title>[^<]+<\/title>/);
  if (target === 'preview') {
    assert.match(r.headers.get('x-robots-tag') || '', /noindex/);
    assert.ok(!text.includes('googletagmanager.com/gtag/js'), 'No preview GA');
  } else {
    assert.ok(!(r.headers.get('x-robots-tag') || '').includes('noindex'), 'Production cannot be noindex');
    assert.ok(path === '/write' || text.includes('G-D6DNTFLDXZ'), 'Keep the existing production GA');
  }
  results.push({ path, status: r.status, canonical: true, hreflang: true });
}
for (const path of ['/robots.txt', '/llms.txt', '/rss.xml', '/en/rss.xml', '/sitemap-index.xml', '/sitemap-0.xml']) {
  const r = await fetch(new URL(path, base)); const text = await r.text();
  assert.equal(r.status, 200, path); assert.ok(text.length > 20, path);
  if (path.includes('sitemap')) assert.ok(!text.includes('/write'), 'Writer excluded from sitemap');
  results.push({ path, status: r.status });
}
console.log(JSON.stringify({ base, target, results }));
