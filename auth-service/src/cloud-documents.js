const META_KEY = 'price-document:meta';
const CHUNK_PREFIX = 'price-document:chunk:';
const CHUNK_CHARACTERS = 16384;
const MAX_DOCUMENT_BYTES = 19 * 1024 * 1024;
const encoder = new TextEncoder();

async function checksum(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function keysFor(meta) {
  return Array.from({length:meta.chunks}, (_, index) => CHUNK_PREFIX + meta.revision + ':' + index);
}

function validDocument(document) {
  return document && typeof document === 'object' && !Array.isArray(document) &&
    document.app && typeof document.app === 'object' && Array.isArray(document.app.rows) &&
    (document.initial === null || (document.initial && typeof document.initial === 'object' && Array.isArray(document.initial.rows))) &&
    document.versions && typeof document.versions === 'object' &&
    Array.isArray(document.versions.items) && document.versions.items.length > 0;
}

function validMeta(meta) {
  return meta && Number.isSafeInteger(meta.revision) && meta.revision > 0 &&
    Number.isSafeInteger(meta.chunks) && meta.chunks > 0 && meta.chunks <= 2048 &&
    /^[a-f0-9]{64}$/.test(meta.hash || '') && typeof meta.updatedAt === 'string';
}

async function readDocument(storage, meta, fail) {
  if (!validMeta(meta)) fail(503, 'stored_document_invalid', '云端数据暂时无法读取，请保留本机数据并稍后重试。');
  const keys = keysFor(meta), values = new Map();
  for (let index = 0; index < keys.length; index += 64) {
    const batch = await storage.get(keys.slice(index, index + 64));
    for (const [key, value] of batch) values.set(key, value);
  }
  const chunks = keys.map(key => values.get(key));
  if (chunks.some(value => typeof value !== 'string')) fail(503, 'stored_document_incomplete', '云端数据暂时无法完整读取，请稍后重试。');
  const text = chunks.join('');
  if (await checksum(text) !== meta.hash) fail(503, 'stored_document_invalid', '云端数据校验失败，请保留本机数据并稍后重试。');
  let document;
  try { document = JSON.parse(text); } catch (_) { fail(503, 'stored_document_invalid', '云端数据暂时无法读取。'); }
  if (!validDocument(document)) fail(503, 'stored_document_invalid', '云端数据格式异常，请保留本机数据。');
  return document;
}

export async function handlePriceData(request, ctx, {readJson, fail, json}) {
  const previous = await ctx.storage.get(META_KEY);
  if (request.method === 'GET') {
    if (!previous) return json({exists:false,revision:0});
    const url = new URL(request.url);
    if (url.searchParams.get('metadata') === '1') {
      if (!validMeta(previous)) fail(503, 'stored_document_invalid', '云端数据暂时无法读取。');
      return json({exists:true,revision:previous.revision,updatedAt:previous.updatedAt});
    }
    return json({exists:true,revision:previous.revision,updatedAt:previous.updatedAt,document:await readDocument(ctx.storage,previous,fail)});
  }
  const body = await readJson(request);
  if (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0 ||
      typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{12,100}$/.test(body.requestId)) {
    fail(400, 'invalid_revision', '同步请求无效，请刷新页面后重试。');
  }
  if (!validDocument(body.document)) fail(400, 'invalid_document', '同步数据需要包含完整版本、备注和测算内容。');
  const text = JSON.stringify(body.document);
  if (encoder.encode(text).byteLength > MAX_DOCUMENT_BYTES) fail(413, 'document_too_large', '当前数据过大，请先备份并减少图片后重试。');
  const hash = await checksum(text);
  if (previous && !validMeta(previous)) fail(503, 'stored_document_invalid', '云端数据暂时无法读取，请保留本机数据。');
  if (previous?.requestId === body.requestId) {
    if (previous.hash !== hash) fail(409, 'request_id_reused', '同步请求已变化，请重新保存。');
    return json({ok:true,revision:previous.revision,updatedAt:previous.updatedAt});
  }
  const revision = previous?.revision || 0;
  if (body.baseRevision !== revision) {
    fail(409, 'revision_conflict', '其他电脑已更新这份测算表。请先加载云端数据，再合并本机修改。');
  }
  const chunks = [];
  for (let index = 0; index < text.length; index += CHUNK_CHARACTERS) chunks.push(text.slice(index,index + CHUNK_CHARACTERS));
  const meta = {revision:revision + 1,updatedAt:new Date().toISOString(),chunks:chunks.length,hash,requestId:body.requestId};
  await ctx.storage.transaction(async transaction => {
    // Write all chunks and the version pointer atomically; failed saves preserve the previous document.
    for (let index = 0; index < chunks.length; index += 64) {
      const batch = {};
      for (let offset = index; offset < Math.min(index + 64,chunks.length); offset++) batch[CHUNK_PREFIX + meta.revision + ':' + offset] = chunks[offset];
      await transaction.put(batch);
    }
    await transaction.put(META_KEY,meta);
    if (previous) {
      const oldKeys = keysFor(previous);
      for (let index = 0; index < oldKeys.length; index += 64) await transaction.delete(oldKeys.slice(index,index + 64));
    }
  });
  return json({ok:true,revision:meta.revision,updatedAt:meta.updatedAt});
}
