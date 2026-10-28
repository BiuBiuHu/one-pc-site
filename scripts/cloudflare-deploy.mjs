import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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
// Upload the exact production artifact through an explicit no-domain config.
// Wrangler requires a value after --routes; an empty CLI flag is invalid.
let stageConfig;
if (process.argv[3] === '--stage-only') {
  if (target !== 'production') throw new Error('Staging override applies only to production');
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error('Explicit account/token required for staging');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/domains`, { headers: { Authorization: `Bearer ${token}` } });
  const domains = await response.json();
  if (!response.ok || !domains.success) throw new Error('Cannot verify staging hostname isolation');
  if (domains.result.some(domain => domain.service === config.env.production.name)) throw new Error('Stage-only is limited to initial bootstrap before domain binding');
  config.env.production.routes = [];
  config.main = path.resolve(config.main);
  config.assets.directory = path.resolve(config.assets.directory);
  stageConfig = path.resolve('.cloudflare/wrangler-stage.json');
  writeFileSync(stageConfig, JSON.stringify(config, null, 2) + '\n');
  args.push('--config', stageConfig);
}
try { execFileSync(process.execPath, args, { stdio: 'inherit' }); }
finally { if (stageConfig) unlinkSync(stageConfig); }
