const META_KEY = 'operating-dashboard-document:meta';
const CHUNK_PREFIX = 'operating-dashboard-document:chunk:';
const CHUNK_CHARACTERS = 16384;
const MAX_DOCUMENT_BYTES = 19 * 1024 * 1024;
const REQUIRED_COLUMNS = ['月份', '月销量', '月销售额(CNY)', '赛盒利润'];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const encoder = new TextEncoder();

async function checksum(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function numeric(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && Number.isFinite(Number(value)));
}

function validDocument(document) {
  return record(document) && document.schemaVersion === 1 &&
    typeof document.sourceName === 'string' && document.sourceName.trim().length > 0 && document.sourceName.length <= 255 &&
    Array.isArray(document.rows) && document.rows.length > 0 && document.rows.length <= 100000 &&
    document.rows.every(row => record(row) &&
      REQUIRED_COLUMNS.every(key => Object.hasOwn(row, key)) &&
      /^20\d{2}(?:0[1-9]|1[0-2])$/.test(String(row['月份'])) &&
      REQUIRED_COLUMNS.slice(1).every(key => numeric(row[key])) &&
      Object.entries(row).every(([key, value]) => !UNSAFE_KEYS.has(key) &&
        (value === null || typeof value === 'string' || typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value)))));
}

function validMeta(meta) {
  return meta && Number.isSafeInteger(meta.revision) && meta.revision > 0 &&
    meta.baseRevision === meta.revision - 1 &&
    Number.isSafeInteger(meta.chunks) && meta.chunks > 0 && meta.chunks <= 2048 &&
    /^[a-f0-9]{64}$/.test(meta.hash || '') && typeof meta.updatedAt === 'string' &&
    /^[a-zA-Z0-9_-]{12,100}$/.test(meta.requestId || '');
}

function keysFor(meta) {
  return Array.from({ length: meta.chunks }, (_, index) => CHUNK_PREFIX + meta.revision + ':' + index);
}

async function readDocument(storage, meta, fail) {
  const keys = keysFor(meta), values = new Map();
  for (let index = 0; index < keys.length; index += 64) {
    const batch = await storage.get(keys.slice(index, index + 64));
    for (const [key, value] of batch) values.set(key, value);
  }
  const chunks = keys.map(key => values.get(key));
  if (chunks.some(value => typeof value !== 'string')) fail(503, 'stored_document_incomplete', '云端驾驶舱数据暂时无法完整读取，请保留本机数据并稍后重试。');
  const text = chunks.join('');
  if (await checksum(text) !== meta.hash) fail(503, 'stored_document_invalid', '云端驾驶舱数据校验失败，请保留本机数据并稍后重试。');
  let document;
  try { document = JSON.parse(text); } catch (_) { fail(503, 'stored_document_invalid', '云端驾驶舱数据格式异常，请保留本机数据。'); }
  if (!validDocument(document)) fail(503, 'stored_document_invalid', '云端驾驶舱数据格式异常，请保留本机数据。');
  return document;
}

export async function handleDashboardData(request, ctx, { readJson, fail, json }) {
  const previous = await ctx.storage.get(META_KEY);
  if (previous && !validMeta(previous)) fail(503, 'stored_document_invalid', '云端驾驶舱数据暂时无法读取，请保留本机数据。');
  if (request.method === 'GET') {
    if (!previous) return json({ exists: false, revision: 0 });
    const metadata = { exists: true, revision: previous.revision, updatedAt: previous.updatedAt };
    if (new URL(request.url).searchParams.get('metadata') === '1') return json(metadata);
    return json({ ...metadata, document: await readDocument(ctx.storage, previous, fail) });
  }
  const body = await readJson(request);
  if (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0 ||
      typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{12,100}$/.test(body.requestId)) {
    fail(400, 'invalid_revision', '同步请求无效，请刷新页面后重试。');
  }
  if (!validDocument(body.document)) fail(400, 'invalid_document', '请保存完整驾驶舱明细数据，包含月份、月销量、月销售额(CNY)和赛盒利润。');
  const text = JSON.stringify(body.document);
  if (encoder.encode(text).byteLength > MAX_DOCUMENT_BYTES) fail(413, 'document_too_large', '驾驶舱数据过大，请减少明细后重试。');
  const hash = await checksum(text);
  if (previous?.requestId === body.requestId) {
    if (previous.hash !== hash || previous.baseRevision !== body.baseRevision) fail(409, 'request_id_reused', '同步请求已变化，请重新保存。');
    return json({ ok: true, revision: previous.revision, updatedAt: previous.updatedAt });
  }
  const revision = previous?.revision || 0;
  if (body.baseRevision !== revision) fail(409, 'revision_conflict', '其他电脑已更新驾驶舱。请先加载云端数据，再合并本机修改。');
  const chunks = [];
  for (let index = 0; index < text.length; index += CHUNK_CHARACTERS) chunks.push(text.slice(index, index + CHUNK_CHARACTERS));
  const meta = {
    revision: revision + 1, baseRevision: revision, updatedAt: new Date().toISOString(),
    chunks: chunks.length, hash, requestId: body.requestId,
  };
  await ctx.storage.transaction(async transaction => {
    // Store the full document and version pointer together; failed saves leave the prior version intact.
    for (let index = 0; index < chunks.length; index += 64) {
      const batch = {};
      for (let offset = index; offset < Math.min(index + 64, chunks.length); offset++) batch[CHUNK_PREFIX + meta.revision + ':' + offset] = chunks[offset];
      await transaction.put(batch);
    }
    await transaction.put(META_KEY, meta);
    if (previous) {
      const oldKeys = keysFor(previous);
      for (let index = 0; index < oldKeys.length; index += 64) await transaction.delete(oldKeys.slice(index, index + 64));
    }
  });
  return json({ ok: true, revision: meta.revision, updatedAt: meta.updatedAt });
}
