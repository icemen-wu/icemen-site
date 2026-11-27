import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DOMAIN = 'api.icemen.bond';
export const API_URL = 'https://api.cloudflare.com/client/v4/accounts/af10091b32e14bd12f1b22069314f266/pages/projects/icemen-api-gateway/domains';
const MAX_AUTH_OUTPUT = 64 * 1024;
const STATUSES = new Set(['initializing', 'pending', 'active', 'deactivated', 'blocked', 'error']);
const ERROR_CODES = new Set([
  'invalid_wrangler_path', 'wrangler_auth_failed', 'invalid_auth_response',
  'unsupported_auth_response', 'invalid_domain_response', 'cloudflare_unreachable',
  'invalid_cloudflare_response', 'cloudflare_request_failed', 'invalid_mode', 'domain_operation_failed',
]);

function safeErrorCode(value) {
  return ERROR_CODES.has(value) || /^cloudflare_http_[1-5]\d{2}$/.test(value) ? value : 'domain_operation_failed';
}

export class DomainError extends Error {
  constructor(code) { super(safeErrorCode(code)); this.code = safeErrorCode(code); }
}

function validToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 16384 && /^[A-Za-z0-9._~+/-]+=*$/.test(value);
}

export function captureWranglerOAuth({ wranglerPath, env = process.env, spawnImpl = spawn } = {}) {
  if (typeof wranglerPath !== 'string' || !path.isAbsolute(wranglerPath) || /[\r\n\0]/.test(wranglerPath)) {
    return Promise.reject(new DomainError('invalid_wrangler_path'));
  }
  return new Promise((resolve, reject) => {
    let child, output = '', settled = false;
    const fail = code => {
      if (settled) return;
      settled = true; output = '';
      reject(new DomainError(code));
    };
    try {
      // The documented CLI owns credential access/refresh. Its JSON stays in this pipe only.
      child = spawnImpl(process.execPath, [wranglerPath, 'auth', 'token', '--json'], {
        env: { ...env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'error' },
        shell: false, windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (_) { fail('wrangler_auth_failed'); return; }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled) return;
      output += chunk;
      if (output.length > MAX_AUTH_OUTPUT) { fail('invalid_auth_response'); child.kill(); }
    });
    // Drain, but never retain or echo diagnostics that might contain credentials.
    child.stderr.resume();
    child.once('error', () => fail('wrangler_auth_failed'));
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) { fail('wrangler_auth_failed'); return; }
      let credential;
      try { credential = JSON.parse(output); } catch (_) { fail('invalid_auth_response'); return; }
      output = '';
      if (!credential || credential.type !== 'oauth' || !validToken(credential.token)) {
        fail('unsupported_auth_response'); return;
      }
      settled = true;
      resolve(credential.token);
    });
  });
}

function safeDomain(value) {
  if (!value || value.name !== DOMAIN) throw new DomainError('invalid_domain_response');
  return {
    domain: DOMAIN,
    status: STATUSES.has(value.status) ? value.status : 'unknown',
    validationStatus: STATUSES.has(value.validation_data?.status) ? value.validation_data.status : 'unknown',
  };
}

async function apiRequest(method, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(API_URL, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + token, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify({ name: DOMAIN }) } : {}),
    });
  } catch (_) { throw new DomainError('cloudflare_unreachable'); }
  // Provider messages and raw response bodies are deliberately never returned to the caller.
  if (!response.ok) throw new DomainError('cloudflare_http_' + (Number.isInteger(response.status) ? response.status : 'error'));
  let data;
  try { data = await response.json(); } catch (_) { throw new DomainError('invalid_cloudflare_response'); }
  if (data?.success !== true) throw new DomainError('cloudflare_request_failed');
  return data.result;
}

export async function manageDomain(mode, {
  env = process.env,
  getToken = () => captureWranglerOAuth({ wranglerPath: env.ICEMEN_WRANGLER_JS, env }),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!['status', 'attach'].includes(mode)) throw new DomainError('invalid_mode');
  let token;
  try {
    token = await getToken();
    if (!validToken(token)) throw new DomainError('unsupported_auth_response');
    const domains = await apiRequest('GET', token, fetchImpl);
    if (!Array.isArray(domains)) throw new DomainError('invalid_cloudflare_response');
    const existing = domains.find(value => value?.name === DOMAIN);
    if (existing) return safeDomain(existing);
    if (mode === 'status') return { domain: DOMAIN, status: 'not_attached', validationStatus: 'unknown' };
    return safeDomain(await apiRequest('POST', token, fetchImpl));
  } finally { token = undefined; }
}

export async function runCli({ argv = process.argv.slice(2), write = value => process.stdout.write(value), ...dependencies } = {}) {
  try {
    if (argv.length > 1) throw new DomainError('invalid_mode');
    const result = await manageDomain(argv[0] || 'status', dependencies);
    write(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    // Only our fixed codes survive; arbitrary child/API exceptions can contain private values.
    const code = error instanceof DomainError ? safeErrorCode(error.code) : 'domain_operation_failed';
    write(JSON.stringify({ domain: DOMAIN, status: code, validationStatus: 'unknown' }) + '\n');
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCli();
}
