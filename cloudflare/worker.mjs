import health from '../api/health.js';
import { createHandler as list } from '../api/list.js';
import { createHandler as get } from '../api/get.js';
import { createHandler as post } from '../api/post.js';
import { createHandler as remove } from '../api/delete.js';
import { createHandler as comments } from '../api/comments.js';

const factories = { list, get, post, delete: remove, comments };
const MAX_BODY_BYTES = 1024 * 1024;

function jsonError(status, message) {
  return Response.json({ ok: false, message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new RangeError('body too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  return text ? JSON.parse(text) : {};
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/_vercel/') || url.pathname.startsWith('/_vitals/')) {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5);
      if (name !== 'health' && !Object.hasOwn(factories, name)) return jsonError(404, '接口不存在');
      // A preview must never write to the production content branch.
      if (env.DEPLOY_ENV !== 'production' && (!env.GH_BRANCH || env.GH_BRANCH === 'main') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        return jsonError(403, 'Preview writes require an isolated branch');
      }
      let body;
      try { body = await readBody(request); }
      catch (error) { return jsonError(error instanceof RangeError ? 413 : 400, '请求内容无效'); }
      let status = 200;
      let output;
      const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Hosting-Provider': 'cloudflare' });
      if (env.DEPLOY_ENV !== 'production') headers.set('X-Robots-Tag', 'noindex, nofollow');
      const response = {
        setHeader(key, value) { headers.set(key, value); },
        status(code) { status = code; return this; },
        json(value) { headers.set('Content-Type', 'application/json; charset=utf-8'); output = JSON.stringify(value); return this; },
        end(value) { output = value; return this; },
      };
      try {
        const handler = name === 'health' ? health : factories[name](env);
        await handler({ method: request.method, query: Object.fromEntries(url.searchParams), body }, response);
        return new Response(output, { status, headers });
      } catch {
        // Never return provider error bodies or secrets to clients/logs.
        return jsonError(502, '上游服务暂不可用');
      }
    }
    return env.ASSETS.fetch(request);
  },
};
