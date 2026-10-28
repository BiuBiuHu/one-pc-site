// Routes retain the existing Vercel CNAME as origin. A same-zone fetch reaches
// that origin without running this Route again. Do not replace with a Custom Domain.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const isTelemetry = url.pathname.startsWith('/_vercel/') || url.pathname.startsWith('/_vitals/');
    if (isApi || isTelemetry) {
      if (env.READ_ONLY_ORIGIN === 'true') {
        if (isTelemetry) return new Response(null, { status: 204 });
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
          return Response.json({ ok: false, message: 'Preview is read-only' }, { status: 403 });
        }
      }
      const upstream = new URL(url.pathname + url.search, env.LEGACY_ORIGIN);
      const response = await fetch(new Request(upstream, request), {
        redirect: 'manual',
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      const result = new Response(response.body, response);
      result.headers.set('Cache-Control', 'no-store');
      return result;
    }
    return env.ASSETS.fetch(request);
  },
};
