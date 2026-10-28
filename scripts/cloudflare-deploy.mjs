import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hashAssets } from './cloudflare-artifact.mjs';

const target = process.argv[2];
if (!['preview', 'production'].includes(target)) throw new Error('Specify preview or production');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) throw new Error('Commit or save changes before deploying');
const commit = git('rev-parse', 'HEAD');
const artifact = JSON.parse(readFileSync('.cloudflare/deployment-manifest.json', 'utf8'));
if (artifact.target !== target) throw new Error('Artifact environment mismatch; rebuild for the chosen target');
if (artifact.sourceCommit !== commit) throw new Error('Artifact is stale; run npm run build:cloudflare');
const actual = await hashAssets(path.resolve('.cloudflare/assets'));
if (actual.assetsSha256 !== artifact.assetsSha256) throw new Error('Asset digest mismatch; rebuild before deploying');
if (target === 'production') {
  const defaultBranch = "main";
  execFileSync('git', ['fetch', 'origin', defaultBranch], { stdio: 'inherit' });
  if (git('rev-parse', `origin/${defaultBranch}`) !== commit) throw new Error('Production must use the current remote default-branch commit');
}
const args = ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--env', target];
if (process.env.CLOUDFLARE_SECRETS_FILE) args.push('--secrets-file', process.env.CLOUDFLARE_SECRETS_FILE);
// Upload the final production artifact before changing any public hostname.
if (process.argv[3] === '--stage-only') {
  if (target !== 'production') throw new Error('Staging override applies only to production');
  args.push('--routes');
}
execFileSync(process.execPath, args, { stdio: 'inherit' });
