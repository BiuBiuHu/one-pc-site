import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { hashAssets } from './cloudflare-artifact.mjs';
import path from 'node:path';

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceCommit) throw new Error('CI source commit mismatch');
const target = process.env.CLOUDFLARE_DEPLOY_ENV || 'preview';
if (!['preview', 'production'].includes(target)) throw new Error('Invalid build target');
const assets = path.resolve('.cloudflare/assets');
if (target === 'production') {
  const fs = await import('node:fs/promises');
  await fs.rm(path.join(assets, '_headers'), { force: true });
}
if (target === 'preview') await writeFile(path.join(assets, '_headers'), '/*\n  X-Robots-Tag: noindex, nofollow\n');
await writeFile(path.join(assets, '__deployment.json'), JSON.stringify({ provider: 'cloudflare', sourceCommit, target }) + '\n');
const { assetsSha256, files } = await hashAssets(assets);
await writeFile('.cloudflare/deployment-manifest.json', JSON.stringify({ sourceCommit, target, assetsSha256, files }, null, 2) + '\n');
console.log(`Cloudflare artifact: ${sourceCommit}, ${files} files`);
