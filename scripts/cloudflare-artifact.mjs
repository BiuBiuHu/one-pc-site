import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
export async function hashAssets(assets) {
  const hash = createHash('sha256');
  let files = 0;
  async function scan(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(file);
      else { hash.update(path.relative(assets, file)); hash.update('\0'); hash.update(await readFile(file)); files++; }
    }
  }
  await scan(assets);
  return { assetsSha256: hash.digest('hex'), files };
}
