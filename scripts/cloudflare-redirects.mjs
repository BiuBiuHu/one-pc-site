import { readFile, writeFile } from 'node:fs/promises';

// Keep one source of truth for existing article URLs while Vercel is retained.
const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
const rules = (config.redirects ?? []).map(({ source, destination, permanent }) => {
  if (!source.startsWith('/') || !destination.startsWith('/') || /[\s\r\n]/.test(source + destination)) {
    throw new Error(`Unsupported redirect: ${source}`);
  }
  return `${source} ${destination} ${permanent ? 308 : 307}`;
});
await writeFile(new URL('../.cloudflare/assets/_redirects', import.meta.url), rules.join('\n') + '\n');
console.log(`Prepared ${rules.length} Cloudflare article redirects`);
