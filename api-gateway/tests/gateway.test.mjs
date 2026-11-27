import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Import as a module without a package.json affecting the rest of the site.
const source = await readFile(new URL('../public/_worker.js', import.meta.url), 'utf8');
const gateway = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
const productionOrigin = 'https://icemen.bond';

test('passes the exact request and streamed body to the existing Worker', async () => {
  const body = JSON.stringify({ baseRevision: 4, requestId: 'fixture-save-request', document: { rows: ['原始中文明细', 'x'.repeat(300000)] } });
  const request = new Request('https://api.icemen.bond/api/data/operating-dashboard?fixture=1', {
    method: 'POST',
    headers: { Origin: productionOrigin, Authorization: 'Bearer disposable-fixture-token', 'Content-Type': 'application/json', 'X-Fixture': 'unchanged' },
    body,
  });
  let calls = 0;
  const upstream = new Response('{"ok":true,"revision":5}', { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': productionOrigin } });
  const result = await gateway.fetch(request, { AUTH: { async fetch(received) {
    calls++;
    assert.strictEqual(received, request);
    assert.equal(received.url, request.url);
    assert.equal(received.method, 'POST');
    assert.equal(received.headers.get('Authorization'), 'Bearer disposable-fixture-token');
    assert.equal(received.headers.get('Origin'), productionOrigin);
    assert.equal(received.headers.get('X-Fixture'), 'unchanged');
    assert.equal(await received.text(), body);
    return upstream;
  } } });
  assert.equal(calls, 1);
  assert.strictEqual(result, upstream);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), productionOrigin);
  assert.deepEqual(await result.json(), { ok: true, revision: 5 });
});

test('passes OPTIONS and CORS headers without introducing another login layer', async () => {
  const request = new Request('https://api.icemen.bond/api/login', { method: 'OPTIONS', headers: {
    Origin: productionOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, authorization',
  } });
  const upstream = new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': productionOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
  } });
  const result = await gateway.fetch(request, { AUTH: { async fetch(received) {
    assert.strictEqual(received, request); assert.equal(received.method, 'OPTIONS'); return upstream;
  } } });
  assert.strictEqual(result, upstream);
  assert.equal(result.status, 204);
  assert.equal(result.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type');
  assert.equal(await result.text(), '');
});

test('preserves downstream auth, conflict and rate-limit responses without retrying', async () => {
  for (const status of [401, 403, 409, 413, 429, 503]) {
    const request = new Request('https://api.icemen.bond/api/session', { headers: { Origin: productionOrigin } });
    let calls = 0;
    const upstream = new Response(JSON.stringify({ error: 'fixture_' + status, message: '原始错误' }), { status, headers: {
      'Content-Type': 'application/json', 'Retry-After': '30', Vary: 'Origin', 'Access-Control-Allow-Origin': productionOrigin,
    } });
    const result = await gateway.fetch(request, { AUTH: { async fetch() { calls++; return upstream; } } });
    assert.equal(calls, 1); assert.strictEqual(result, upstream); assert.equal(result.status, status);
    assert.equal(result.headers.get('Retry-After'), '30');
    assert.equal((await result.json()).error, 'fixture_' + status);
  }
});

test('does not call public fetch and fails safely on absent or broken bindings', async () => {
  const originalFetch = globalThis.fetch;
  let publicCalls = 0;
  globalThis.fetch = async () => { publicCalls++; throw new Error('Public-network requests are forbidden in this fixture'); };
  try {
    const fixtures = [
      {}, { AUTH: {} }, { AUTH: { fetch: null } },
      { AUTH: { async fetch() { throw new Error('Private failure containing disposable-secret'); } } },
    ];
    for (const origin of [productionOrigin, 'http://127.0.0.1:8778', 'https://untrusted.example', null]) {
      for (const env of fixtures) {
        const request = new Request('https://api.icemen.bond/api/login', { method: 'POST', headers: origin ? { Origin: origin } : {}, body: 'disposable-private-body' });
        const result = await gateway.fetch(request, env);
        assert.equal(result.status, 503);
        assert.equal(result.headers.get('Cache-Control'), 'no-store');
        assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff');
        assert.equal(result.headers.get('Vary'), 'Origin');
        assert.equal(result.headers.get('Access-Control-Allow-Origin'), [productionOrigin, 'http://127.0.0.1:8778'].includes(origin) ? origin : null);
        const text = await result.text();
        assert(!text.includes('disposable-secret')); assert(!text.includes('disposable-private-body'));
        assert.deepEqual(JSON.parse(text), { error: 'service_unavailable', message: '服务暂时不可用，请稍后重试。' });
      }
    }
    assert.equal(publicCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('deployment config targets the existing Worker and introduces no credentials or storage', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.name, 'icemen-api-gateway');
  assert.equal(config.compatibility_date, '2026-11-27');
  assert.equal(config.pages_build_output_dir, './public');
  assert.deepEqual(config.services, [{ binding: 'AUTH', service: 'icemen-auth' }]);
  for (const forbidden of ['vars', 'durable_objects', 'migrations', 'routes', 'kv_namespaces']) assert(!Object.hasOwn(config, forbidden));
});
