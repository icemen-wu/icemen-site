export const MAX_UPLOAD_JSON_BYTES = Math.floor(14.1 * 1024 * 1024);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const REPOSITORY = 'icemen-wu/icemen-site';
const BRANCH = 'main';
const PREFIX = '/repos/' + REPOSITORY;
const API_ROOT = 'https://api.github.com';
const ALLOWED_EXTENSIONS = new Set('html htm pdf txt csv xlsx xls docx pptx zip png jpg jpeg webp gif'.split(' '));
const SHA = /^[a-f0-9]{40}$/;
const encoder = new TextEncoder();

export class GitHubError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new GitHubError(status, code, message);
}

function sha(value) {
  if (typeof value !== 'string' || !SHA.test(value)) fail(502, 'github_invalid_response', 'GitHub 返回的数据不完整，请稍后重试。');
  return value;
}

function extension(filename) {
  return filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
}

function validateFilename(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || encoder.encode(value).length > 255 ||
      /[\\/\u0000-\u001f\u007f]/.test(value) || value.startsWith('.') || !ALLOWED_EXTENSIONS.has(extension(value))) {
    fail(400, 'invalid_filename', '文件名无效或文件类型不支持，请选择允许的文件类型。');
  }
  return value;
}

// Return the actual Git tree path, never an arbitrary URL supplied by a client.
function modulePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || /[\\?#\u0000-\u001f\u007f]/.test(value)) return null;
  const relative = value.startsWith('./') ? value.slice(2) : value;
  let segments;
  try { segments = relative.split('/').map(segment => decodeURIComponent(segment)); } catch (_) { return null; }
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\\/\u0000-\u001f\u007f]/.test(segment))) return null;
  const first = segments[0].toLowerCase();
  if (segments.some(segment => segment.startsWith('.')) ||
      ['assets', 'scripts', 'config', 'auth-service', 'node_modules'].includes(first)) return null;
  const path = segments.join('/');
  if (path.toLowerCase() === 'index.html' || !ALLOWED_EXTENSIONS.has(extension(segments.at(-1)))) return null;
  // A colon in the first component would turn this into an absolute URL.
  if (segments[0].includes(':')) return null;
  return path;
}

function contentsPath(path) {
  return PREFIX + '/contents/' + path.split('/').map(encodeURIComponent).join('/');
}

function base64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return btoa(binary);
}

function utf8Base64(value) {
  return base64(encoder.encode(value));
}

function decodeBase64(value, maxBytes) {
  if (typeof value === 'string' && value.length > 4 * Math.ceil(maxBytes / 3)) {
    fail(413, 'file_too_large', '文件不能超过 10 MiB。');
  }
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    fail(400, 'invalid_content', '文件内容编码无效。');
  }
  const size = value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  if (size > maxBytes) fail(413, 'file_too_large', '文件不能超过 10 MiB。');
  let binary;
  try { binary = atob(value); } catch (_) { fail(400, 'invalid_content', '文件内容编码无效。'); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function textField(value, fallback, maxLength, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > maxLength || (label === '名称' && !value.trim())) {
    fail(400, 'invalid_metadata', label + '填写无效或过长。');
  }
  return value.trim();
}

async function fingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function preserveCalculatorSync(contentBase64) {
  let html;
  try {
    html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decodeBase64(contentBase64, MAX_FILE_BYTES));
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    fail(400, 'calculator_encoding', '价格测算表请使用 UTF-8 编码的 HTML 文件。');
  }
  // Skip entire inline scripts and comments: a sample tag in embedded data must
  // not be mistaken for a running adapter, or used as an insertion point.
  const blocks = /<!--[\s\S]*?-->|<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>[\s\S]*?<\/script\s*>|<\/body\s*>|<\/html\s*>/gi;
  let bodyEnd = -1, htmlEnd = -1;
  for (const match of html.matchAll(blocks)) {
    if (match[1] !== undefined) {
      const attributes = match[1];
      const source = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attributes);
      const type = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attributes);
      const scriptType = (type ? type[1] ?? type[2] ?? type[3] : '').trim().toLowerCase();
      if (source && ['', 'text/javascript', 'application/javascript', 'module'].includes(scriptType) &&
          !/(?:^|\s)nomodule(?:\s|=|$)/i.test(attributes)) {
        try {
          const url = new URL(source[1] ?? source[2] ?? source[3], 'https://icemen.bond/价格测算表.html');
          if (url.origin === 'https://icemen.bond' && url.pathname === '/assets/price-cloud-sync.js') return contentBase64;
        } catch (_) {}
      }
    } else if (/^<\/body/i.test(match[0])) bodyEnd = match.index;
    else if (/^<\/html/i.test(match[0])) htmlEnd = match.index;
  }
  const insertion = bodyEnd >= 0 ? bodyEnd : htmlEnd >= 0 ? htmlEnd : html.length;
  const tag = '\n<script src="./assets/price-cloud-sync.js" defer></script>\n';
  const result = encoder.encode(html.slice(0, insertion) + tag + html.slice(insertion));
  if (result.byteLength > MAX_FILE_BYTES) fail(413, 'file_too_large', '加入云同步组件后文件超过 10 MiB，请先减少图片或内容。');
  return base64(result);
}

export class GitHubFiles {
  constructor(storage) {
    this.storage = storage;
  }

  async api(token, method, path, body, options = {}) {
    if (!path.startsWith(PREFIX + '/') && path !== PREFIX) throw new Error('Invalid GitHub API route');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(API_ROOT + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ICEMEN-Workspace',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.status === 404 && options.allowMissing) return null;
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) {
          fail(403, options.code || 'github_permission_denied', options.permissionMessage ||
            'GitHub 令牌无效、已过期或无权访问指定仓库，请重新连接并检查权限。');
        }
        if (options.refUpdate && [409, 422].includes(response.status)) {
          fail(409, 'head_changed', '仓库已有新提交，请刷新文件列表后重新确认上传。');
        }
        if ([429].includes(response.status)) fail(429, 'github_rate_limited', 'GitHub 请求过于频繁，请稍后重试。');
        fail(502, 'github_request_failed', 'GitHub 暂时无法处理请求，请稍后重试。');
      }
      try { return await response.json(); } catch (_) {
        fail(502, 'github_invalid_response', 'GitHub 返回的数据不完整，请稍后重试。');
      }
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      fail(502, 'github_unavailable', '暂时无法连接 GitHub，请保留当前文件并使用同一请求重试。');
    } finally { clearTimeout(timeout); }
  }

  async connection() {
    const connection = await this.storage.get('githubConnection');
    if (!connection?.token) fail(409, 'github_not_connected', '请先在设置中连接 GitHub 仓库。');
    return connection;
  }

  async status() {
    const connection = await this.storage.get('githubConnection');
    return {
      configured: Boolean(connection?.token), repository: REPOSITORY, branch: BRANCH,
      ...(connection?.token ? { connectedAt: connection.connectedAt } : {}),
    };
  }

  async head(token) {
    const reference = await this.api(token, 'GET', PREFIX + '/git/ref/heads/' + BRANCH);
    return sha(reference?.object?.sha);
  }

  async snapshot(token) {
    const headSha = await this.head(token);
    const content = await this.api(token, 'GET', contentsPath('navigation.json') + '?ref=' + headSha);
    if (content?.encoding !== 'base64' || typeof content.content !== 'string') {
      fail(502, 'invalid_navigation', '仓库中的 navigation.json 无法读取。');
    }
    let navigation;
    try {
      const encoded = content.content.replace(/\s/g, '');
      navigation = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(encoded, 1024 * 1024)));
    } catch (_) { fail(502, 'invalid_navigation', '仓库中的 navigation.json 内容无效，请先修复配置。'); }
    const ids = new Set();
    if (!navigation || !Array.isArray(navigation.modules) || navigation.modules.some(module => {
      if (!module || typeof module.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(module.id) || ids.has(module.id) ||
          typeof module.name !== 'string' || typeof module.path !== 'string') return true;
      ids.add(module.id);
      return false;
    })) fail(502, 'invalid_navigation', '仓库中的模块列表格式无效，请先修复配置。');
    return { headSha, navigation, navigationContent: content.content.replace(/\s/g, '') };
  }

  async connect(body) {
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!/^[\x21-\x7e]{1,1024}$/.test(token)) fail(400, 'invalid_github_token', '请填写有效的 GitHub 令牌，长度不能超过 1 KiB。');
    const repository = await this.api(token, 'GET', PREFIX);
    if (repository?.full_name?.toLowerCase() !== REPOSITORY || repository.archived) {
      fail(403, 'github_repository_unavailable', '令牌无法写入指定仓库，或仓库已经归档。');
    }
    const snapshot = await this.snapshot(token);
    // Re-upload identical content as a deduplicated blob: verifies Contents write
    // without changing any branch, creating a commit, or relying on role metadata.
    const probe = await this.api(token, 'POST', PREFIX + '/git/blobs', {
      content: snapshot.navigationContent, encoding: 'base64',
    }, { permissionMessage: '请为指定仓库授予 Contents（内容）读写权限后重新连接。' });
    sha(probe?.sha);
    await this.api(token, 'GET', PREFIX + '/actions/runs?per_page=1', undefined, {
      code: 'github_actions_permission', permissionMessage: '请为指定仓库授予 Actions（操作）读取权限后重新连接。',
    });
    await this.storage.put('githubConnection', { token, repository: REPOSITORY, branch: BRANCH, connectedAt: Date.now() });
    return this.status();
  }

  async files() {
    const connection = await this.connection();
    const snapshot = await this.snapshot(connection.token);
    return { modules: snapshot.navigation.modules, headSha: snapshot.headSha };
  }

  async saveRecord(record) {
    const saved = await this.storage.get('fileUploadRequestIds');
    const previous = Array.isArray(saved) ? saved : [];
    const ids = previous.filter(id => id !== record.requestId).concat(record.requestId).slice(-100);
    // Each record stays well below the Durable Object per-value storage limit.
    await this.storage.put({
      ['fileUploadRequest:' + record.requestId]: record,
      fileUploadRequestIds: ids,
    });
    const removed = previous.filter(id => !ids.includes(id));
    if (removed.length) await this.storage.delete(removed.map(id => 'fileUploadRequest:' + id));
  }

  async finish(record) {
    const completed = { ...record, status: 'success', completedAt: Date.now() };
    await this.saveRecord(completed);
    return completed.result;
  }

  async resume(token, record) {
    const currentHead = await this.head(token);
    if (currentHead === record.commitSha) return this.finish(record);
    if (currentHead !== record.baseHead) {
      const comparison = await this.api(token, 'GET', PREFIX + '/compare/' + record.commitSha + '...' + currentHead);
      if (['ahead', 'identical'].includes(comparison?.status)) return this.finish(record);
      fail(409, 'head_changed', '仓库已有新提交；本次上传尚未应用，请刷新后重新确认。');
    }
    await this.api(token, 'PATCH', PREFIX + '/git/refs/heads/' + BRANCH, { sha: record.commitSha, force: false }, { refUpdate: true });
    return this.finish(record);
  }

  async upload(body) {
    if (!['create', 'update'].includes(body.mode)) fail(400, 'invalid_mode', '请选择新增或更新文件。');
    if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId)) {
      fail(400, 'invalid_request_id', '上传请求标识无效，请重新选择文件。');
    }
    const filename = validateFilename(body.filename);
    if (body.expectedHead !== undefined && (typeof body.expectedHead !== 'string' || !SHA.test(body.expectedHead))) {
      fail(400, 'invalid_head', '仓库版本标识无效，请刷新文件列表。');
    }
    let contentDigest;
    {
      const bytes = decodeBase64(body.contentBase64, MAX_FILE_BYTES);
      contentDigest = await fingerprint(bytes);
    }
    const identity = await fingerprint(encoder.encode(JSON.stringify({
      mode: body.mode, moduleId: body.moduleId, filename, name: body.name,
      description: body.description, category: body.category,
      expectedHead: body.expectedHead, contentDigest,
    })));
    const existing = await this.storage.get('fileUploadRequest:' + body.requestId);
    if (existing) {
      if (existing.fingerprint !== identity) fail(409, 'request_id_reused', '此请求标识已用于其他文件或内容，请重新开始上传。');
      if (existing.status === 'success') return existing.result;
      const connection = await this.connection();
      return this.resume(connection.token, existing);
    }
    const connection = await this.connection();
    const token = connection.token;
    const snapshot = await this.snapshot(token);
    if (body.expectedHead && body.expectedHead !== snapshot.headSha) {
      fail(409, 'head_changed', '仓库已有新提交，请刷新文件列表后重新确认上传。');
    }
    const modules = snapshot.navigation.modules.map(module => ({ ...module }));
    let path, module;
    if (body.mode === 'create') {
      path = 'files/' + filename;
      if (modules.some(item => modulePath(item.path) === path)) fail(409, 'file_exists', '已有同名文件，请选择更新或更换文件名。');
      const collision = await this.api(token, 'GET', contentsPath(path) + '?ref=' + snapshot.headSha, undefined, { allowMissing: true });
      if (collision) fail(409, 'file_exists', '仓库中已有同名文件，请选择更新或更换文件名。');
      let id;
      do { id = 'file-' + Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join(''); }
      while (modules.some(item => item.id === id));
      module = {
        id,
        name: textField(body.name, filename, 120, '名称'),
        path: './files/' + encodeURIComponent(filename),
        description: textField(body.description, '', 2000, '描述'),
        category: textField(body.category, '工具与资料', 80, '分类'),
        tags: [],
      };
      modules.push(module);
    } else {
      if (typeof body.moduleId !== 'string') fail(400, 'invalid_module', '请选择要更新的模块。');
      module = modules.find(item => item.id === body.moduleId);
      if (!module) fail(404, 'module_not_found', '模块已不存在，请刷新文件列表。');
      path = modulePath(module.path);
      if (!path) fail(400, 'protected_path', '只能更新本站模块文件，不能修改首页、脚本或配置。');
      const aliases = value => ({ htm: 'html', jpeg: 'jpg' })[value] || value;
      if (aliases(extension(filename)) !== aliases(extension(path))) fail(400, 'file_type_mismatch', '请选择与原模块文件类型相同的文件。');
      module.name = textField(body.name, module.name, 120, '名称');
      module.description = textField(body.description, module.description || '', 2000, '描述');
      module.category = textField(body.category, module.category || '工具与资料', 80, '分类');
    }
    const fileContent = body.mode === 'update' && module.id === 'price' && path === '价格测算表.html'
      ? preserveCalculatorSync(body.contentBase64)
      : body.contentBase64;
    const commit = await this.api(token, 'GET', PREFIX + '/git/commits/' + snapshot.headSha);
    const baseTree = sha(commit?.tree?.sha);
    const fileBlob = await this.api(token, 'POST', PREFIX + '/git/blobs', { content: fileContent, encoding: 'base64' });
    const navigationBlob = await this.api(token, 'POST', PREFIX + '/git/blobs', {
      content: utf8Base64(JSON.stringify({ ...snapshot.navigation, modules }, null, 2) + '\n'), encoding: 'base64',
    });
    const tree = await this.api(token, 'POST', PREFIX + '/git/trees', {
      base_tree: baseTree,
      tree: [
        { path, mode: '100644', type: 'blob', sha: sha(fileBlob?.sha) },
        { path: 'navigation.json', mode: '100644', type: 'blob', sha: sha(navigationBlob?.sha) },
      ],
    });
    const created = await this.api(token, 'POST', PREFIX + '/git/commits', {
      message: (body.mode === 'create' ? 'Add ' : 'Update ') + filename + ' from ICEMEN workspace',
      tree: sha(tree?.sha), parents: [snapshot.headSha],
    });
    const commitSha = sha(created?.sha);
    const record = {
      requestId: body.requestId, fingerprint: identity, status: 'prepared', createdAt: Date.now(),
      baseHead: snapshot.headSha, commitSha,
      result: { ok: true, sha: commitSha, module, mode: body.mode, publishStatus: 'pending' },
    };
    // Persist before updating the branch so retries can recover a lost response.
    await this.saveRecord(record);
    return this.resume(token, record);
  }

  async publishStatus(value) {
    if (typeof value !== 'string' || !SHA.test(value)) fail(400, 'invalid_sha', '提交标识无效。');
    const connection = await this.connection();
    const data = await this.api(connection.token, 'GET', PREFIX + '/actions/runs?head_sha=' + value + '&per_page=30', undefined, {
      code: 'github_actions_permission',
      permissionMessage: '文件提交不受影响，但当前令牌无法读取发布状态；请补充 Actions（操作）读取权限。',
    });
    if (!Array.isArray(data?.workflow_runs)) fail(502, 'github_invalid_response', '暂时无法读取发布状态，文件提交不受影响。');
    const run = data.workflow_runs.find(item => item.head_sha === value && /pages/i.test(String(item.name || '') + ' ' + String(item.path || '')));
    let status = 'pending';
    if (run?.status === 'completed') status = run.conclusion === 'success' ? 'success' : 'failure';
    return {
      status, sha: value,
      url: run?.id && Number.isSafeInteger(run.id)
        ? 'https://github.com/' + REPOSITORY + '/actions/runs/' + run.id
        : 'https://github.com/' + REPOSITORY + '/actions',
    };
  }
}
