import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const base = process.argv[2];
if (!base) throw new Error('Usage: node scripts/check-cloudflare.mjs <base-url>');
const root = path.resolve('.cloudflare/assets');
const files = [];
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await scan(file); else files.push(path.relative(root, file));
  }
}
await scan(root);
let checked = 0;
const routes = files.filter(file => !['_headers', '_redirects', '404.html', '.DS_Store'].includes(file));
for (let i = 0; i < routes.length; i += 6) {
  await Promise.all(routes.slice(i, i + 6).map(async file => {
    const route = '/' + file.replace(/(^|\/)index\.html$/, '').replace(/\/$/, '');
    const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, `${route}: ${response.status}`);
    await response.arrayBuffer();
    checked++;
  }));
}
const missing = await fetch(new URL('/__migration_missing_page__', base));
assert.equal(missing.status, 404, 'Missing paths must return 404');
let redirects = 0;
try {
  const rules = (await readFile(path.join(root, '_redirects'), 'utf8')).trim().split('\n').filter(Boolean);
  for (const rule of rules) {
    const [source, destination, status] = rule.split(/\s+/);
    const response = await fetch(new URL(source, base), { redirect: 'manual' });
    assert.equal(response.status, Number(status), `Redirect ${source}`);
    assert.equal(new URL(response.headers.get('location'), base).pathname, destination, `Location ${source}`);
    redirects++;
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const provenance = await (await fetch(new URL('/__deployment.json', base))).json();
const manifest = JSON.parse(await readFile('.cloudflare/deployment-manifest.json', 'utf8'));
assert.equal(provenance.sourceCommit, manifest.sourceCommit, 'Deployed commit mismatch');
assert.equal(provenance.target, manifest.target, 'Deployed environment mismatch');
if (manifest.target === 'preview') {
  const response = await fetch(base);
  assert.match(response.headers.get('x-robots-tag') || '', /noindex/);
}
console.log(JSON.stringify({ base, pagesAndAssets: checked, redirects, missingPage: 404, ...provenance }));
