const ALLOWED_ORIGINS = new Set([
  'https://icemen.bond',
  'http://127.0.0.1:8778',
]);
const SESSION_MS = 8 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100000;
const MAX_JSON_BYTES = 4096;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 10;
const MAX_RATE_ENTRIES = 10000;
const encoder = new TextEncoder();

class ApiError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function jsonResponse(request, data, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
    ...extraHeaders,
  });
  const origin = request.headers.get('Origin');
  if (ALLOWED_ORIGINS.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(request, error) {
  if (error instanceof ApiError) {
    return jsonResponse(request, { error: error.code, message: error.message }, error.status, error.headers);
  }
  // Never include request data, stored credentials, or exception details.
  return jsonResponse(request, { error: 'service_unavailable', message: '服务暂时不可用，请稍后重试。' }, 503);
}

function checkOrigin(request, requireOrigin = false) {
  const origin = request.headers.get('Origin');
  if ((requireOrigin && !origin) || (origin && !ALLOWED_ORIGINS.has(origin))) {
    throw new ApiError(403, 'origin_not_allowed', '不允许此网站调用。');
  }
}

function preflight(request) {
  checkOrigin(request, true);
  const method = request.headers.get('Access-Control-Request-Method');
  const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if ((method && !['GET', 'POST'].includes(method)) ||
      requestedHeaders.some(value => !['authorization', 'content-type'].includes(value))) {
    throw new ApiError(403, 'preflight_not_allowed', '不允许此请求。');
  }
  const response = jsonResponse(request, null);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.headers.set('Access-Control-Max-Age', '600');
  return new Response(null, { status: 204, headers: response.headers });
}

function route(request) {
  const pathname = new URL(request.url).pathname;
  const methods = {
    '/api/health': 'GET',
    '/api/login': 'POST',
    '/api/session': 'GET',
    '/api/password': 'POST',
  };
  const method = methods[pathname];
  if (!method) throw new ApiError(404, 'not_found', '接口不存在。');
  if (request.method !== method) {
    throw new ApiError(405, 'method_not_allowed', '请求方法不支持。', { Allow: method });
  }
  checkOrigin(request, request.method === 'POST');
  return pathname;
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw new ApiError(415, 'json_required', '请使用 JSON 请求。');
  }
  const length = Number(request.headers.get('Content-Length'));
  if (length > MAX_JSON_BYTES) throw new ApiError(413, 'request_too_large', '请求内容过大。');
  if (!request.body) throw new ApiError(400, 'invalid_json', '请求内容无效。');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new ApiError(413, 'request_too_large', '请求内容过大。');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch (_) {
    throw new ApiError(400, 'invalid_json', '请求内容无效。');
  }
}

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value) {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{2})+$/i.test(value)) throw new Error('Invalid stored encoding');
  return Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
}

function randomHex(length) {
  return hex(crypto.getRandomValues(new Uint8Array(length)));
}

async function passwordHash(password, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(salt), iterations,
  }, material, 256);
  return hex(new Uint8Array(bits));
}

function equalHex(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid token encoding');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function invalidCredentials(status = 401) {
  return new ApiError(status, 'invalid_credentials', '口令不正确。');
}

function invalidSession() {
  return new ApiError(401, 'invalid_session', '登录已失效，请重新进入。');
}

export class AuthState {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.failures = new Map();
    this.queue = Promise.resolve();
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('auth');
      if (saved) {
        if (saved.schema !== 1 || !/^[a-f0-9]{32}$/.test(saved.salt) ||
            !/^[a-f0-9]{64}$/.test(saved.hash) || !/^[a-f0-9]{64}$/.test(saved.signingSecret) ||
            saved.iterations !== PBKDF2_ITERATIONS || !Number.isSafeInteger(saved.passwordVersion) || saved.passwordVersion < 1) {
          throw new Error('Invalid stored auth state');
        }
        this.auth = saved;
        return;
      }
      if (!/^[a-f0-9]{32}$/.test(env.INITIAL_PASSWORD_SALT || '') ||
          !/^[a-f0-9]{64}$/.test(env.INITIAL_PASSWORD_HASH || '')) {
        throw new Error('Initial password configuration missing');
      }
      const initial = {
        schema: 1,
        salt: env.INITIAL_PASSWORD_SALT,
        hash: env.INITIAL_PASSWORD_HASH,
        iterations: PBKDF2_ITERATIONS,
        passwordVersion: 1,
        signingSecret: randomHex(32),
      };
      await ctx.storage.put('auth', initial);
      this.auth = initial;
    });
  }

  fetch(request) {
    // Serialize authentication changes, including asynchronous PBKDF2 operations.
    const result = this.queue.then(async () => {
      try {
        await this.ready;
        return await this.handle(request);
      } catch (error) {
        return errorResponse(request, error);
      }
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  pruneFailures(now) {
    for (const [key, entry] of this.failures) {
      if (entry.resetAt <= now) this.failures.delete(key);
    }
    while (this.failures.size >= MAX_RATE_ENTRIES) {
      this.failures.delete(this.failures.keys().next().value);
    }
  }

  rateKey(request) {
    return request.headers.get('CF-Connecting-IP') || 'unknown';
  }

  checkRateLimit(key) {
    const now = Date.now();
    this.pruneFailures(now);
    const entry = this.failures.get(key);
    if (entry?.count >= MAX_FAILURES) {
      throw new ApiError(429, 'too_many_attempts', '尝试次数过多，请稍后再试。', {
        'Retry-After': String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))),
      });
    }
  }

  recordFailure(key) {
    const now = Date.now();
    const entry = this.failures.get(key);
    this.failures.set(key, entry && entry.resetAt > now
      ? { count: entry.count + 1, resetAt: entry.resetAt }
      : { count: 1, resetAt: now + FAILURE_WINDOW_MS });
  }

  async verifyPassword(password) {
    const computed = await passwordHash(password, this.auth.salt, this.auth.iterations);
    return equalHex(computed, this.auth.hash);
  }

  async signingKey() {
    return crypto.subtle.importKey('raw', fromHex(this.auth.signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }

  async makeToken() {
    const now = Date.now();
    const expiresAt = now + SESSION_MS;
    const body = base64url(encoder.encode(JSON.stringify({
      version: this.auth.passwordVersion,
      issuedAt: now,
      expiresAt,
      nonce: randomHex(16),
    })));
    const signature = await crypto.subtle.sign('HMAC', await this.signingKey(), encoder.encode(body));
    return { token: body + '.' + base64url(new Uint8Array(signature)), expiresAt };
  }

  async session(request) {
    const authorization = request.headers.get('Authorization') || '';
    const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization);
    if (!match || match[1].length > 2048) throw invalidSession();
    try {
      const parts = match[1].split('.');
      if (parts.length !== 2) throw new Error();
      const valid = await crypto.subtle.verify('HMAC', await this.signingKey(), decodeBase64url(parts[1]), encoder.encode(parts[0]));
      if (!valid) throw new Error();
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64url(parts[0])));
      const now = Date.now();
      if (data.version !== this.auth.passwordVersion || !Number.isSafeInteger(data.issuedAt) ||
          !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= now || data.issuedAt > now + 30000 ||
          data.expiresAt - data.issuedAt !== SESSION_MS) throw new Error();
      return data;
    } catch (_) {
      throw invalidSession();
    }
  }

  async handle(request) {
    const pathname = route(request);
    if (pathname === '/api/session') {
      const session = await this.session(request);
      return jsonResponse(request, { ok: true, expiresAt: session.expiresAt });
    }
    if (pathname === '/api/login') {
      const key = this.rateKey(request);
      this.checkRateLimit(key);
      const body = await readJson(request);
      if (typeof body.password !== 'string' || !body.password || body.password.length > 256) {
        throw new ApiError(400, 'invalid_password', '请输入有效口令。');
      }
      if (!await this.verifyPassword(body.password)) {
        this.recordFailure(key);
        throw invalidCredentials();
      }
      this.failures.delete(key);
      return jsonResponse(request, await this.makeToken());
    }
    if (pathname === '/api/password') {
      await this.session(request);
      const key = this.rateKey(request);
      this.checkRateLimit(key);
      const body = await readJson(request);
      if (typeof body.currentPassword !== 'string' || !body.currentPassword || body.currentPassword.length > 256 ||
          typeof body.newPassword !== 'string') {
        throw new ApiError(400, 'invalid_password', '请输入当前口令与新口令。');
      }
      const length = body.newPassword.length;
      if (length < 8 || length > 64 || !body.newPassword.trim()) {
        throw new ApiError(400, 'invalid_new_password', '新口令须为 8–64 个字符，且不能全为空白。');
      }
      if (!await this.verifyPassword(body.currentPassword)) {
        this.recordFailure(key);
        throw invalidCredentials(403);
      }
      if (body.newPassword === body.currentPassword) {
        throw new ApiError(400, 'password_unchanged', '新口令须与当前口令不同。');
      }
      const salt = randomHex(16);
      const updated = {
        ...this.auth,
        salt,
        hash: await passwordHash(body.newPassword, salt, PBKDF2_ITERATIONS),
        passwordVersion: this.auth.passwordVersion + 1,
        signingSecret: randomHex(32),
      };
      await this.ctx.storage.put('auth', updated);
      this.auth = updated;
      this.failures.clear();
      return jsonResponse(request, { ok: true, requiresLogin: true });
    }
    throw new ApiError(404, 'not_found', '接口不存在。');
  }
}

export default {
  async fetch(request, env) {
    try {
      if (request.method === 'OPTIONS') return preflight(request);
      const pathname = route(request);
      if (pathname === '/api/health') return jsonResponse(request, { ok: true });
      const id = env.AUTH_STATE.idFromName('icemen-global-auth-v1');
      return await env.AUTH_STATE.get(id).fetch(request);
    } catch (error) {
      return errorResponse(request, error);
    }
  },
};
