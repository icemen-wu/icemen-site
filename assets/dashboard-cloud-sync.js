(() => {
  'use strict';
  if (window.__icemenDashboardCloudSyncInstalled) return;
  window.__icemenDashboardCloudSyncInstalled = true;

  const bridge = window.IcemenOperatingDashboard;
  const SESSION_KEY = 'icemen.navigation.access';
  const META_KEY = 'icemen.operating-dashboard-cloud.v1';
  const API_PATH = '/api/data/operating-dashboard';
  const BACKUP_DB = 'icemen-operating-dashboard-backups-v1';
  const MAX_BYTES = 19 * 1024 * 1024;
  let ui, apiBase = '', initialized = false, applying = false;
  let revision = 0, remoteRevision = 0, baseline = '', dirty = false, generation = 0, updatedAt = '';
  let saveBusy = false, loadBusy = false, pollBusy = false, pendingRequest = null;
  let startupCheck = Promise.resolve(), backupDatabase, backupEntries = [];
  let configBusy = false, needsFullLoad = true, retryTimer = null, retryDelay = 1500;

  function scheduleRefresh(backoff = false) {
    if (location.protocol === 'file:' || retryTimer !== null) return;
    const delay = backoff ? retryDelay : 1000;
    if (backoff) retryDelay = Math.min(retryDelay * 2, 30000);
    retryTimer = setTimeout(() => { retryTimer = null; void refreshConnection(); }, delay);
  }

  function deferLoad(text) {
    needsFullLoad = true;
    message(text, 'pending');
    scheduleRefresh();
    return false;
  }

  function validateDocument(value) {
    const numeric = ['月销量', '月销售额(CNY)', '赛盒利润'];
    if (!value || value.schemaVersion !== 1 || typeof value.sourceName !== 'string' ||
        !value.sourceName.trim() || value.sourceName.length > 255 ||
        !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 100000) {
      throw new Error('经营数据格式不正确，未替换本机数据。');
    }
    for (const row of value.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) ||
          !/^20\d{2}(0[1-9]|1[0-2])$/.test(String(row['月份'] || '')) ||
          numeric.some(key => !Object.hasOwn(row, key) ||
            !(row[key] === null || ((typeof row[key] === 'number' || typeof row[key] === 'string') && Number.isFinite(Number(row[key])))))) {
        throw new Error('经营明细缺少有效月份、销量、销售额或利润，未替换数据。');
      }
      for (const [key, cell] of Object.entries(row)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key) ||
            !(cell === null || ['string', 'boolean'].includes(typeof cell) || (typeof cell === 'number' && Number.isFinite(cell)))) {
          throw new Error('经营明细包含不支持的字段，未替换本机数据。');
        }
      }
    }
    return value;
  }

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }

  async function fingerprint(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function message(text, kind = '') {
    if (!ui) return;
    ui.status.textContent = text;
    ui.bar.dataset.kind = kind;
    ui.save.textContent = saveBusy ? '正在保存…' : '保存更新';
  }

  function persistMetadata() {
    try { localStorage.setItem(META_KEY, JSON.stringify({ revision, baseline, dirty, updatedAt })); } catch (_) {}
  }

  function markDirty() {
    if (applying) return;
    generation++;
    dirty = true;
    persistMetadata();
    if (!saveBusy) message(remoteRevision > revision
      ? '其他电脑有新数据，稍后将先备份本机修改，再自动加载最新数据。'
      : '数据已在本机更新，点击“保存更新”同步到其他电脑。', 'pending');
    refreshButtons();
  }

  function session() {
    try {
      const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (value && typeof value.token === 'string' && value.token && Number(value.until) > Date.now()) return value;
    } catch (_) {}
    return null;
  }

  function refreshButtons() {
    if (!ui) return;
    ui.save.disabled = saveBusy || loadBusy || !!bridge.isImporting?.();
    ui.login.hidden = !!session();
    ui.login.disabled = !apiBase || saveBusy || loadBusy;
    ui.load.disabled = !apiBase || saveBusy || loadBusy;
    ui.restore.hidden = !backupEntries.length;
    ui.restore.disabled = saveBusy || loadBusy;
    ui.save.textContent = saveBusy ? '正在保存…' : '保存更新';
  }

  async function apiRequest(path, body, token = session()?.token) {
    if (!apiBase) throw new Error('云同步尚未连接，本机数据仍保留。');
    if (path !== '/api/login' && !token) {
      const error = new Error('请使用工作台口令登录同步。');
      error.status = 401; error.requestAuthentication = token; throw error;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(apiBase + path, {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit', cache: 'no-store', signal: controller.signal
      });
      let result;
      try { result = await response.json(); } catch (_) { throw new Error('云同步服务返回异常，请稍后重试。'); }
      if (!response.ok) {
        const error = new Error(result.message || '云同步失败，请稍后重试。');
        error.status = response.status; error.code = result.error; error.requestAuthentication = token; throw error;
      }
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('云同步超时；本机数据仍保留。');
      if (error instanceof TypeError) throw new Error('无法连接云同步服务，请检查网络后重试；本机数据仍保留。');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function handleError(error, context = '云同步失败') {
    if (error.status === 401) {
      const current = session();
      if (current && current.token !== error.requestAuthentication) { refreshButtons(); return; }
      try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
      message('登录已过期或口令已更新，请登录同步；本机修改仍保留。', 'error');
    } else if (error.status === 409) {
      message('其他电脑已保存新数据，正在备份本机修改并自动加载最新数据。', 'pending');
    } else message(context + '：' + error.message, 'error');
    refreshButtons();
  }

  async function openBackups() {
    if (backupDatabase) return backupDatabase;
    backupDatabase = new Promise((resolve, reject) => {
      const request = indexedDB.open(BACKUP_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('无法打开本机备份存储。'));
      request.onblocked = () => reject(new Error('本机备份存储被其他页面占用。'));
    }).catch(error => { backupDatabase = null; throw error; });
    return backupDatabase;
  }

  async function refreshBackups() {
    try {
      const db = await openBackups();
      backupEntries = await new Promise((resolve, reject) => {
        const request = db.transaction('metadata', 'readonly').objectStore('metadata').getAll();
        request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
        request.onerror = () => reject(new Error('无法读取本机备份。'));
      });
    } catch (_) { backupEntries = []; }
    refreshButtons();
  }

  async function writeBackup(document, reason) {
    const db = await openBackups();
    const item = { id: crypto.randomUUID(), createdAt: Date.now(), reason, rows: document.rows.length, sourceName: document.sourceName };
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['documents', 'metadata'], 'readwrite');
      transaction.objectStore('documents').put({ id: item.id, document: structuredClone(document) });
      transaction.objectStore('metadata').put(item);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(new Error('本机完整备份未保存成功，未替换现有数据。'));
      transaction.onabort = () => reject(new Error('本机备份未完成，未替换现有数据。'));
    });
    backupEntries.unshift(item); refreshButtons();
  }

  async function readBackup(id) {
    const db = await openBackups();
    return new Promise((resolve, reject) => {
      const request = db.transaction('documents', 'readonly').objectStore('documents').get(id);
      request.onsuccess = () => request.result ? resolve(request.result.document) : reject(new Error('未找到所选备份。'));
      request.onerror = () => reject(new Error('无法读取所选备份。'));
    });
  }

  function replaceLocal(document) {
    validateDocument(document);
    applying = true;
    try { return bridge.apply(document); }
    finally { applying = false; }
  }

  async function acceptCloud(result, force, startedAtGeneration) {
    if (!result.exists) {
      if (revision > 0) throw new Error('云端数据暂不可用，保留本机数据，请稍后重试。');
      remoteRevision = 0;
      needsFullLoad = false;
      message('云端尚无经营数据，点击“保存更新”首次同步整份数据。', 'pending');
      return false;
    }
    if (!Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error('云端版本号无效，未替换数据。');
    if (result.revision < revision) throw new Error('收到过期云端版本，将自动重新检查。');
    validateDocument(result.document);
    remoteRevision = Math.max(remoteRevision, result.revision);
    if (!force && result.revision === revision) { needsFullLoad = false; return true; }
    if (bridge.isImporting?.()) return deferLoad('正在导入 Excel，完成后会自动检查云端最新数据。');
    const before = generation, current = bridge.capture();
    const [localFingerprint, cloudFingerprint] = await Promise.all([fingerprint(current), fingerprint(result.document)]);
    if (generation !== before || generation !== startedAtGeneration) {
      return deferLoad('读取期间本机数据有变化，稍后将先备份，再自动加载最新数据。');
    }
    if (localFingerprint === cloudFingerprint) {
      revision = result.revision; baseline = localFingerprint; dirty = false;
      updatedAt = result.updatedAt || ''; pendingRequest = null; persistMetadata();
      needsFullLoad = false; retryDelay = 1500;
      message('经营数据已与云端一致，其他电脑可查看相同数据。', 'success'); return true;
    }
    const hadUnsavedChanges = dirty;
    const backupGeneration = generation;
    await writeBackup(current, hadUnsavedChanges ? '自动加载最新前（未保存修改）' : '自动加载最新前');
    if (generation !== backupGeneration || bridge.isImporting?.()) {
      return deferLoad('备份期间本机数据有变化，现有数据保留，稍后会自动重试。');
    }
    const persisted = replaceLocal(result.document);
    revision = result.revision; remoteRevision = result.revision;
    baseline = cloudFingerprint; dirty = false; updatedAt = result.updatedAt || '';
    pendingRequest = null; needsFullLoad = false; retryDelay = 1500; persistMetadata();
    message(persisted === false ? '已加载云端最新数据；本机存储空间不足，关闭后可重新联网加载。'
      : '已自动加载云端最新数据 · ' + new Date(updatedAt || Date.now()).toLocaleString('zh-CN') + (hadUnsavedChanges ? '；本机未保存修改已备份，可从“恢复本机备份”找回。' : '；原本机数据已备份。'), 'success');
    return true;
  }

  async function loadCloud(force = needsFullLoad) {
    if (loadBusy || saveBusy || bridge.isImporting?.()) {
      if (force) needsFullLoad = true;
      scheduleRefresh(); return false;
    }
    if (!session()) return false;
    loadBusy = true; refreshButtons();
    const startedAtGeneration = generation;
    try {
      const result = await apiRequest(API_PATH);
      return await acceptCloud(result, force, startedAtGeneration);
    } catch (error) {
      needsFullLoad = true; handleError(error, '自动加载暂未完成，稍后自动重试');
      if (error.status !== 401) scheduleRefresh(true);
      return false;
    }
    finally { loadBusy = false; refreshButtons(); }
  }

  async function saveCloud() {
    await startupCheck;
    if (saveBusy || loadBusy || bridge.isImporting?.()) return;
    if (!apiBase) {
      message(location.protocol === 'file:' ? '当前为本地文件，数据仅保留在本机；请从工作台网站打开以同步。'
        : '云同步暂未连接，正在自动重连；连上后请再次保存，本机数据仍保留。', 'pending');
      scheduleRefresh(true); return;
    }
    if (!session()) { message('请登录同步，再点击“保存更新”；本机数据仍保留。', 'pending'); openLogin(); return; }
    saveBusy = true; refreshButtons();
    let conflict = false;
    try {
      const document = validateDocument(bridge.capture());
      if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_BYTES) throw new Error('完整数据超过19 MiB，未删减任何内容；请减少数据量后重试。');
      const sentGeneration = generation, sentFingerprint = await fingerprint(document);
      if (!pendingRequest || pendingRequest.fingerprint !== sentFingerprint || pendingRequest.baseRevision !== revision) {
        pendingRequest = { requestId: crypto.randomUUID(), baseRevision: revision, document, fingerprint: sentFingerprint };
      }
      message('正在保存整份经营数据到云端…', 'pending');
      const result = await apiRequest(API_PATH, {
        baseRevision: pendingRequest.baseRevision, requestId: pendingRequest.requestId, document: pendingRequest.document
      });
      if (!result.ok || !Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error('云端未返回有效保存结果，请重试。');
      revision = result.revision; remoteRevision = result.revision; baseline = sentFingerprint;
      updatedAt = result.updatedAt || ''; pendingRequest = null; dirty = generation !== sentGeneration;
      needsFullLoad = false; retryDelay = 1500;
      persistMetadata();
      message(dirty ? '本次数据已保存；保存期间的新修改尚未同步，请再次保存。'
        : '已保存到云端 · ' + new Date(updatedAt || Date.now()).toLocaleString('zh-CN') + '，其他电脑打开后自动加载。', dirty ? 'pending' : 'success');
    } catch (error) {
      if (error.status === 409) {
        pendingRequest = null; remoteRevision = Math.max(remoteRevision, revision + 1);
        needsFullLoad = true; conflict = true;
      }
      handleError(error, '保存失败');
    } finally {
      saveBusy = false; refreshButtons();
      if (conflict) await loadCloud(true);
      else scheduleRefresh();
    }
  }

  async function pollCloud() {
    if (!initialized || document.visibilityState === 'hidden' || !session() || saveBusy || loadBusy || pollBusy) return;
    if (bridge.isImporting?.()) { scheduleRefresh(); return; }
    if (needsFullLoad) { await loadCloud(true); return; }
    pollBusy = true;
    try {
      const result = await apiRequest(API_PATH + '?metadata=1');
      if (result.exists && Number.isSafeInteger(result.revision) && result.revision > revision) {
        remoteRevision = result.revision;
        needsFullLoad = true;
        await loadCloud(true);
      }
      retryDelay = 1500;
    } catch (error) {
      handleError(error, '自动检查暂未完成，稍后自动重试');
      if (error.status !== 401) scheduleRefresh(true);
    }
    finally { pollBusy = false; refreshButtons(); }
  }

  async function refreshConnection() {
    if (!initialized || location.protocol === 'file:' || document.visibilityState === 'hidden') return;
    if (!apiBase) {
      if (configBusy) return;
      configBusy = true;
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch('./site-config.json', { cache: 'no-store', credentials: 'omit', signal: controller.signal });
        if (!response.ok) throw new Error('无法读取云同步配置。');
        const config = await response.json(), url = new URL(config.authApi);
        if (url.protocol !== 'https:' && !(location.hostname === '127.0.0.1' && url.hostname === '127.0.0.1' && url.protocol === 'http:')) throw new Error('云同步服务需要使用HTTPS。');
        apiBase = url.href.replace(/\/$/, ''); retryDelay = 1500;
      } catch (error) {
        message('云同步暂未连接，将自动重试；本机数据仍保留。', 'pending');
        scheduleRefresh(true); return;
      } finally { clearTimeout(timeout); configBusy = false; refreshButtons(); }
    }
    if (!session()) {
      message('登录同步后将自动显示云端最新数据；本机修改会先备份。', 'pending');
      refreshButtons(); return;
    }
    await pollCloud();
  }

  function node(tag, properties = {}, text) {
    const element = document.createElement(tag); Object.assign(element, properties);
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function openLogin() {
    if (!ui || !apiBase) return;
    ui.loginMessage.textContent = ''; ui.password.value = '';
    if (!ui.loginDialog.open) ui.loginDialog.showModal();
    ui.password.focus();
  }

  function makeInterface() {
    const style = node('style', {}, '#dashboard-cloud-sync{max-width:1600px;margin:0 auto;padding:0 26px 14px;display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;font-size:11px;color:#becbe1}#dashboard-cloud-status{flex:1;min-width:230px;text-align:right}#dashboard-cloud-sync[data-kind=error] #dashboard-cloud-status{color:#ffb7ba}#dashboard-cloud-sync[data-kind=success] #dashboard-cloud-status{color:#91e4c7}#dashboard-cloud-sync .btn{height:28px;font-size:11px;padding:0 10px}#dashboard-cloud-sync [hidden]{display:none!important}.dashboard-cloud-dialog{width:min(440px,calc(100% - 28px));border:1px solid #dfe6ef;border-radius:12px;padding:24px;box-shadow:0 12px 60px #101b3344;color:#172033}.dashboard-cloud-dialog::backdrop{background:#101b3377}.dashboard-cloud-dialog h2{font-size:19px;margin:0 0 9px}.dashboard-cloud-dialog p{font-size:12px;line-height:1.8;color:#6e7b8f}.dashboard-cloud-dialog label{display:block;margin:16px 0 7px;font-size:12px}.dashboard-cloud-dialog input,.dashboard-cloud-dialog select{width:100%;padding:9px;border:1px solid #dfe6ef;border-radius:6px;font:inherit}.dashboard-cloud-dialog .cloud-message{min-height:20px;color:#b33b49}.dashboard-cloud-dialog .cloud-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.dashboard-cloud-dialog .btn{background:#eef2f9;color:#172033;border-color:#dfe6ef}.dashboard-cloud-dialog .btn-primary{background:#315efb;color:#fff;border-color:#315efb}@media(max-width:620px){#dashboard-cloud-sync{padding:0 14px 14px;justify-content:flex-start}#dashboard-cloud-status{text-align:left;flex-basis:100%}}');
    const bar = node('div', { id: 'dashboard-cloud-sync' });
    const status = node('span', { id: 'dashboard-cloud-status' }, '正在连接云同步…');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const login = node('button', { id: 'dashboardCloudLoginBtn', type: 'button', className: 'btn' }, '登录同步');
    const load = node('button', { id: 'dashboardCloudLoadBtn', type: 'button', className: 'btn', hidden: true }, '加载最新');
    const restore = node('button', { id: 'dashboardCloudRestoreBtn', type: 'button', className: 'btn', hidden: true }, '恢复本机备份');
    bar.append(status, login, load, restore);
    const loginDialog = node('dialog', { className: 'dashboard-cloud-dialog' }), loginForm = node('form');
    const password = node('input', { id: 'dashboard-cloud-password', type: 'password', autocomplete: 'current-password', required: true, maxLength: 64 });
    const loginMessage = node('p', { className: 'cloud-message' }); loginMessage.setAttribute('role', 'status');
    const loginCancel = node('button', { type: 'button', className: 'btn' }, '取消');
    const loginSubmit = node('button', { type: 'submit', className: 'btn btn-primary' }, '登录同步');
    const loginActions = node('div', { className: 'cloud-actions' }); loginActions.append(loginCancel, loginSubmit);
    loginForm.append(node('h2', {}, '登录经营数据同步'), node('p', {}, '使用导航工作台的同一个口令。登录后可保存整份经营数据，并在其他电脑加载。'), node('label', { htmlFor: password.id }, '工作台访问口令'), password, loginMessage, loginActions);
    loginDialog.append(loginForm);
    const backupDialog = node('dialog', { className: 'dashboard-cloud-dialog' }), backupForm = node('form');
    const backupSelect = node('select', { id: 'dashboard-cloud-backup', required: true });
    const backupMessage = node('p', { className: 'cloud-message' }); backupMessage.setAttribute('role', 'status');
    const backupCancel = node('button', { type: 'button', className: 'btn' }, '取消');
    const backupSubmit = node('button', { type: 'submit', className: 'btn btn-primary' }, '恢复备份');
    const backupActions = node('div', { className: 'cloud-actions' }); backupActions.append(backupCancel, backupSubmit);
    backupForm.append(node('h2', {}, '恢复本机备份'), node('p', {}, '加载云端前会保存本机整份经营数据。恢复后仅更新本机；核对后点击“保存更新”才会同步到其他电脑。'), node('label', { htmlFor: backupSelect.id }, '选择备份'), backupSelect, backupMessage, backupActions);
    backupDialog.append(backupForm);
    document.head.append(style); document.querySelector('header').append(bar); document.body.append(loginDialog, backupDialog);
    ui = { bar, status, save: document.getElementById('dashboardSaveBtn'), login, load, restore, loginDialog, password, loginMessage };
    ui.save.addEventListener('click', () => { void saveCloud(); });
    login.addEventListener('click', openLogin);
    loginCancel.addEventListener('click', () => { loginDialog.close(); password.value = ''; });
    loginDialog.addEventListener('cancel', () => { password.value = ''; });
    loginForm.addEventListener('submit', async event => {
      event.preventDefault(); loginSubmit.disabled = true; loginMessage.textContent = '正在验证…';
      try {
        const result = await apiRequest('/api/login', { password: password.value }, '');
        if (typeof result.token !== 'string' || !result.token || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) throw new Error('登录服务未返回有效会话。');
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: result.token, until: result.expiresAt }));
        password.value = ''; loginDialog.close(); refreshButtons();
        needsFullLoad = true;
        startupCheck = loadCloud(true); await startupCheck;
      } catch (error) { password.value = ''; loginMessage.textContent = error.message; }
      finally { loginSubmit.disabled = false; }
    });
    load.addEventListener('click', () => { void loadCloud(true); });
    restore.addEventListener('click', async () => {
      backupMessage.textContent = ''; await refreshBackups(); backupSelect.replaceChildren();
      for (const entry of backupEntries) backupSelect.append(node('option', { value: entry.id }, new Date(entry.createdAt).toLocaleString('zh-CN') + ' · ' + entry.reason + ' · ' + entry.rows.toLocaleString() + '条'));
      if (backupEntries.length) backupDialog.showModal(); else message('尚无本机备份。', 'pending');
    });
    backupCancel.addEventListener('click', () => backupDialog.close());
    backupForm.addEventListener('submit', async event => {
      event.preventDefault(); if (loadBusy || saveBusy || bridge.isImporting?.()) return;
      loadBusy = true; backupSubmit.disabled = true; refreshButtons();
      const startedAtGeneration = generation;
      try {
        const restored = validateDocument(await readBackup(backupSelect.value));
        if (!confirm('将恢复所选整份经营数据，当前数据会另存备份，云端不会自动改变，是否继续？')) return;
        await writeBackup(bridge.capture(), '恢复其他备份前');
        if (generation !== startedAtGeneration) throw new Error('恢复期间本机又有修改，已停止替换。');
        const persisted = replaceLocal(restored); markDirty(); pendingRequest = null; needsFullLoad = false; backupDialog.close();
        message(persisted === false ? '已恢复备份，但本机存储空间不足，请及时保存到云端。' : '已恢复本机备份；请核对后点击“保存更新”同步。', 'pending');
      } catch (error) { backupMessage.textContent = error.message; }
      finally { loadBusy = false; backupSubmit.disabled = false; refreshButtons(); }
    });
  }

  async function initialize() {
    if (!bridge) throw new Error('经营驾驶舱尚未准备好，请刷新重试。');
    needsFullLoad = true;
    let metadata;
    try { metadata = JSON.parse(localStorage.getItem(META_KEY) || '{}') || {}; } catch (_) { metadata = {}; }
    revision = Number.isSafeInteger(metadata.revision) && metadata.revision >= 0 ? metadata.revision : 0;
    baseline = typeof metadata.baseline === 'string' ? metadata.baseline : '';
    updatedAt = typeof metadata.updatedAt === 'string' ? metadata.updatedAt : '';
    dirty = metadata.dirty === true || (!baseline && bridge.hasStoredData());
    makeInterface(); bridge.subscribe(markDirty);
    const initialGeneration = generation;
    const localFingerprint = await fingerprint(bridge.capture());
    if ((baseline && localFingerprint !== baseline) || generation !== initialGeneration) dirty = true;
    persistMetadata(); void refreshBackups();
    if (location.protocol === 'file:') {
      message('当前为本地文件，仅在本机保存。请从工作台网站打开以同步其他电脑。', 'pending'); refreshButtons(); return;
    }
    initialized = true;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden') void refreshConnection(); });
    window.addEventListener('focus', () => { void refreshConnection(); });
    window.addEventListener('online', () => { void refreshConnection(); });
    setInterval(() => { void refreshConnection(); }, 15000);
    await refreshConnection();
    refreshButtons();
  }

  window.addEventListener('beforeunload', event => {
    if (!dirty && !saveBusy) return;
    persistMetadata(); event.preventDefault(); event.returnValue = '';
  });
  startupCheck = initialize().catch(error => { message(error.message, 'error'); refreshButtons(); });
})();
