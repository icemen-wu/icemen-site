const ALLOWED_ORIGINS = new Set([
  'https://icemen.bond',
  'http://127.0.0.1:8778',
]);

function unavailable(request) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  const origin = request.headers.get('Origin');
  if (ALLOWED_ORIGINS.has(origin)) headers.set('Access-Control-Allow-Origin', origin);
  return new Response(JSON.stringify({
    error: 'service_unavailable',
    message: '服务暂时不可用，请稍后重试。',
  }), { status: 503, headers });
}

export default {
  async fetch(request, env) {
    try {
      // Call the existing Worker internally, retaining its auth, data and request stream.
      // Never fall back to a public workers.dev URL or copy credentials to this gateway.
      if (!env.AUTH || typeof env.AUTH.fetch !== 'function') return unavailable(request);
      return await env.AUTH.fetch(request);
    } catch (_) {
      // No request bodies, access tokens or internal exception details enter this response.
      return unavailable(request);
    }
  },
};
