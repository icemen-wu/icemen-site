import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { API_URL, DOMAIN, DomainError, captureWranglerOAuth, manageDomain, runCli } from '../scripts/domain.mjs';

const FIXTURE_TOKEN = 'Disposable-OAuth-Token-For-Tests';
const wranglerPath = path.resolve('fixture', 'wrangler.js');
function mockAuth(output, { exitCode = 0, stderr = '', capture = () => {} } = {}) {
  return (command, args, options) => {
    capture(command, args, options);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.emit('close', 1); };
    queueMicrotask(() => {
      child.stdout.end(output); child.stderr.end(stderr);
      child.emit('close', exitCode);
    });
    return child;
  };
}
const response = (result, status = 200) => new Response(JSON.stringify({ success: true, result }), { status });

test('captures official --json auth in a pipe with disk logging and metrics disabled', async () => {
  let observed;
  const token = await captureWranglerOAuth({ wranglerPath, env: { FIXTURE: 'preserved' }, spawnImpl: mockAuth(JSON.stringify({ type: 'oauth', token: FIXTURE_TOKEN }), {
    stderr: 'must never echo ' + FIXTURE_TOKEN,
    capture: (command, args, options) => { observed = { command, args, options }; },
  }) });
  assert.equal(token, FIXTURE_TOKEN);
  assert.equal(observed.command, process.execPath);
  assert.deepEqual(observed.args, [wranglerPath, 'auth', 'token', '--json']);
  assert.deepEqual(observed.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(observed.options.shell, false); assert.equal(observed.options.windowsHide, true);
  assert.equal(observed.options.timeout, 60000);
  assert.equal(observed.options.env.WRANGLER_WRITE_LOGS, 'false');
  assert.equal(observed.options.env.WRANGLER_SEND_METRICS, 'false');
  assert.equal(observed.options.env.WRANGLER_LOG, 'error');
  assert.equal(observed.options.env.FIXTURE, 'preserved');
});

test('rejects non-OAuth, malformed and oversized auth without leaking stdout or stderr', async () => {
  for (const output of [
    JSON.stringify({ type: 'api_token', token: FIXTURE_TOKEN }),
    JSON.stringify({ type: 'api_key', key: FIXTURE_TOKEN, email: 'fixture@example.invalid' }),
    JSON.stringify({ type: 'oauth', token: FIXTURE_TOKEN + '\r\nInjected: private' }),
    JSON.stringify({ type: 'oauth', token: '' }),
    FIXTURE_TOKEN, 'x'.repeat(65537),
  ]) {
    await assert.rejects(() => captureWranglerOAuth({ wranglerPath, spawnImpl: mockAuth(output, { stderr: FIXTURE_TOKEN }) }), error => {
      assert(!String(error).includes(FIXTURE_TOKEN)); assert(!('cause' in error)); return true;
    });
  }
  await assert.rejects(() => captureWranglerOAuth({ wranglerPath, spawnImpl: mockAuth(JSON.stringify({ type: 'oauth', token: FIXTURE_TOKEN }), { exitCode: 1 }) }), /wrangler_auth_failed/);
  await assert.rejects(() => captureWranglerOAuth({ wranglerPath: 'relative.js', spawnImpl: () => { throw new Error('should not spawn'); } }), /invalid_wrangler_path/);
});

test('status only calls the exact Cloudflare collection and emits a restricted summary', async () => {
  const calls = [];
  const result = await manageDomain('status', { getToken: async () => FIXTURE_TOKEN, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response([{ name: DOMAIN, status: 'pending', validation_data: { status: 'initializing', txt_value: 'private-verification', error_message: FIXTURE_TOKEN }, verification_data: { token: FIXTURE_TOKEN } }]);
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, API_URL);
  assert.equal(new URL(API_URL).host, 'api.cloudflare.com');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + FIXTURE_TOKEN);
  assert.equal(calls[0].options.redirect, 'error');
  assert(!('body' in calls[0].options));
  assert.deepEqual(result, { domain: DOMAIN, status: 'pending', validationStatus: 'initializing' });
  assert(!JSON.stringify(result).includes(FIXTURE_TOKEN)); assert(!JSON.stringify(result).includes('private-verification'));
});

test('attach is idempotent and otherwise posts only the exact approved hostname', async () => {
  const calls = [];
  const dependencies = { getToken: async () => FIXTURE_TOKEN, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return options.method === 'GET' ? response([]) : response({ name: DOMAIN, status: 'pending', validation_data: { status: 'pending' } });
  } };
  assert.deepEqual(await manageDomain('status', dependencies), { domain: DOMAIN, status: 'not_attached', validationStatus: 'unknown' });
  calls.length = 0;
  assert.equal((await manageDomain('attach', dependencies)).domain, DOMAIN);
  assert.deepEqual(calls.map(call => [call.url, call.options.method]), [[API_URL, 'GET'], [API_URL, 'POST']]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: DOMAIN });
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  let count = 0;
  await manageDomain('attach', { getToken: async () => FIXTURE_TOKEN, fetchImpl: async () => {
    count++; return response([{ name: DOMAIN, status: 'active', validation_data: { status: 'active' } }]);
  } });
  assert.equal(count, 1);
});

test('ignores unrelated domains and rejects arbitrary command inputs before obtaining auth', async () => {
  for (const mode of ['https://evil.example', 'delete', 'api.other.example', 'attach --domain other.example']) {
    let authenticated = false;
    await assert.rejects(() => manageDomain(mode, { getToken: async () => { authenticated = true; return FIXTURE_TOKEN; } }), /invalid_mode/);
    assert.equal(authenticated, false);
  }
  const result = await manageDomain('status', { getToken: async () => FIXTURE_TOKEN, fetchImpl: async () => response([{ name: 'other.example', status: 'active' }]) });
  assert.equal(result.status, 'not_attached');
  await assert.rejects(() => manageDomain('attach', { getToken: async () => FIXTURE_TOKEN, fetchImpl: async (_, options) => options.method === 'GET' ? response([]) : response({ name: 'other.example', status: 'active' }) }), /invalid_domain_response/);
});

test('CLI errors never echo credential-bearing exceptions, provider bodies or unexpected statuses', async () => {
  const cases = [
    { getToken: async () => { throw new Error(FIXTURE_TOKEN); } },
    { getToken: async () => { throw new DomainError(FIXTURE_TOKEN); } },
    { getToken: async () => FIXTURE_TOKEN, fetchImpl: async () => { throw new Error('network ' + FIXTURE_TOKEN); } },
    { getToken: async () => FIXTURE_TOKEN, fetchImpl: async () => new Response(FIXTURE_TOKEN, { status: 403 }) },
    { getToken: async () => FIXTURE_TOKEN, fetchImpl: async () => new Response(JSON.stringify({ success: false, errors: [{ message: FIXTURE_TOKEN }] })) },
    { getToken: async () => FIXTURE_TOKEN, fetchImpl: async () => new Response(FIXTURE_TOKEN) },
  ];
  for (const dependencies of cases) {
    let output = '';
    const code = await runCli({ argv: ['status'], write: value => { output += value; }, ...dependencies });
    assert.equal(code, 1); assert(!output.includes(FIXTURE_TOKEN));
    const parsed = JSON.parse(output); assert.deepEqual(Object.keys(parsed).sort(), ['domain', 'status', 'validationStatus'].sort());
    assert.equal(parsed.domain, DOMAIN);
  }
  let output = '';
  assert.equal(await runCli({ argv: ['status'], write: value => { output += value; }, getToken: async () => FIXTURE_TOKEN, fetchImpl: async () => response([{ name: DOMAIN, status: FIXTURE_TOKEN, validation_data: { status: FIXTURE_TOKEN } }]) }), 0);
  assert.deepEqual(JSON.parse(output), { domain: DOMAIN, status: 'unknown', validationStatus: 'unknown' });
  assert(!output.includes(FIXTURE_TOKEN));
});

test('helper source has no filesystem credential access or writes and no shell invocation', async () => {
  const source = await readFile(new URL('../scripts/domain.mjs', import.meta.url), 'utf8');
  assert(!/from ['"]node:fs/.test(source));
  assert(!/\b(?:readFile|writeFile|appendFile|readFileSync|writeFileSync|execSync|execFileSync)\s*\(/.test(source));
  assert(!source.includes('shell: true'));
  assert(!/https:\/\/(?!api\.cloudflare\.com)/.test(source));
});
