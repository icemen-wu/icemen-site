(() => {
  'use strict';

  if (window.__icemenPriceCloudSyncInstalled) return;
  window.__icemenPriceCloudSyncInstalled = true;

  const SESSION_KEY = 'icemen.navigation.access';
  const META_PREFIX = 'icemen.price-cloud-sync.v1:';
  const API_PATH = '/api/data/price-calculator';
  const MAX_BYTES = 19 * 1024 * 1024;
  const BACKUP_DB = 'icemen-price-cloud-backups-v1';
  const clone = value => structuredClone(value);
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  let ui, apiBase = '', localWorkspaceId = '', metaKey = '';
  let originalSave, applying = false, dirty = false, generation = 0;
  let revision = 0, remoteRevision = 0, baseline = '', lastUpdatedAt = '';
  let saveBusy = false, loadBusy = false, saveQueued = false, pollBusy = false;
  let initialized = false, startupCheck = Promise.resolve(), pendingRequest = null;
  let backupDatabase, backupEntries = [], metadata = {};

  function captureDocument() {
    const document = { app: clone(app), initial: clone(initialSnapshot), versions: clone(versions) };
    const active = document.versions?.items?.find(item => item.id === document.versions.activeId);
    if (!active) throw new Error('当前版本尚未准备完成，请稍后重试。');
    active.state = clone(document.app);
    return document;
  }

  function validateDocument(document) {
    if (!document || !validSnapshot(document.app) ||
        (document.initial !== null && !validSnapshot(document.initial)) ||
        !document.versions || !Array.isArray(document.versions.items) || !document.versions.items.length) {
      throw new Error('完整版本数据格式不正确，未替换本机数据。');
    }
    return prepareVersionLibrary(document.versions, upgradeSnapshot(document.app), upgradeSnapshot(document.initial), true);
  }

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }

  async function fingerprint(document) {
    const semantic = clone(document);
    delete semantic.app.workspaceId;
    if (semantic.initial) delete semantic.initial.workspaceId;
    for (const item of semantic.versions.items) {
      delete item.updatedAt;
      delete item.state.workspaceId;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(canonical(semantic)));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function setMessage(message, kind = '') {
    if (!ui) return;
    ui.status.textContent = message;
    ui.bar.dataset.kind = kind;
  }

  function persistMetadata() {
    if (!metaKey) return;
    metadata = { revision, baseline, dirty, updatedAt: lastUpdatedAt };
    try { localStorage.setItem(metaKey, JSON.stringify(metadata)); } catch (_) {}
  }

  function markDirty() {
    if (applying) return;
    generation++;
    dirty = true;
    persistMetadata();
    if (!saveBusy && initialized) setMessage(remoteRevision > revision
      ? '本机有未同步修改，其他电脑也有更新；请先核对云端版本。'
      : '本机有未同步修改，点击“保存更新”同步全部版本。', 'pending');
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
    ui.login.hidden = !!session();
    ui.load.hidden = remoteRevision < 1;
    ui.load.disabled = loadBusy || saveBusy || !session();
    ui.restore.hidden = !backupEntries.length;
    ui.restore.disabled = loadBusy || saveBusy;
  }

  async function apiRequest(path, body, authentication = session()?.token) {
    if (!apiBase) throw new Error('同步服务尚未连接，请稍后重试。');
    if (path !== '/api/login' && !authentication) {
      const error = new Error('请先登录同步；本机数据会继续保留。');
      error.status = 401;
      error.requestAuthentication = authentication;
      throw error;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const headers = { Accept: 'application/json' };
      if (authentication) headers.Authorization = 'Bearer ' + authentication;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(apiBase + path, {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit', cache: 'no-store', signal: controller.signal
      });
      let result;
      try { result = await response.json(); } catch (_) { throw new Error('同步服务返回异常，请稍后重试。'); }
      if (!response.ok) {
        const error = new Error(result.message || '云同步暂时失败，请重试。');
        error.status = response.status;
        error.requestAuthentication = authentication;
        error.code = result.error;
        throw error;
      }
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('云同步连接超时，本机修改仍保留，请重试。');
      if (error instanceof TypeError) throw new Error('无法连接云同步服务，本机修改仍保留。');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function handleError(error, context = '云同步失败') {
    if (error.status === 401) {
      const activeSession = session();
      if (activeSession && activeSession.token !== error.requestAuthentication) {
        refreshButtons();
        return;
      }
      try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
      setMessage('登录已过期或口令已更新；本机修改仍保留，请登录同步。', 'error');
    } else if (error.status === 409 || error.code === 'revision_conflict') {
      setMessage('其他电脑已更新云端。未覆盖任何数据；请加载云端，或先保留本机备份后再处理。', 'error');
    } else setMessage(context + '：' + error.message, 'error');
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

  async function readBackupEntries() {
    const db = await openBackups();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('metadata', 'readonly');
      const request = transaction.objectStore('metadata').getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
      request.onerror = () => reject(new Error('无法读取本机备份列表。'));
    });
  }

  async function refreshBackupEntries() {
    try { backupEntries = await readBackupEntries(); } catch (_) { backupEntries = []; }
    refreshButtons();
  }

  async function writeBackup(document, reason) {
    const db = await openBackups();
    const item = { id: crypto.randomUUID(), createdAt: Date.now(), reason, versions: document.versions.items.length };
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['documents', 'metadata'], 'readwrite');
      transaction.objectStore('documents').put({ id: item.id, document: clone(document) });
      transaction.objectStore('metadata').put(item);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(new Error('无法保存完整本机备份，未替换现有数据。'));
      transaction.onabort = () => reject(new Error('本机备份未完成，未替换现有数据。'));
    });
    backupEntries.unshift(item);
    refreshButtons();
    return item;
  }

  async function readBackup(id) {
    const db = await openBackups();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('documents', 'readonly');
      const request = transaction.objectStore('documents').get(id);
      request.onsuccess = () => request.result ? resolve(request.result.document) : reject(new Error('未找到所选本机备份。'));
      request.onerror = () => reject(new Error('无法读取所选本机备份。'));
    });
  }

  async function replaceLocalDocument(document) {
    const library = validateDocument(document);
    const active = library.items.find(item => item.id === library.activeId);
    applying = true;
    try {
      initialSnapshot = upgradeSnapshot(document.initial);
      adoptVersion({ library, app: active.state }, '完整版本数据已在本机恢复');
      try {
        if (initialSnapshot) localStorage.setItem(initialKey(), JSON.stringify(initialSnapshot));
        else localStorage.removeItem(initialKey());
      } catch (_) {}
    } finally { applying = false; }
    const restored = captureDocument();
    if (PricePersistence.available()) {
      await PricePersistence.write(app.workspaceId || 'main', { ...restored, savedAt: lastSavedAt });
    }
    return restored;
  }

  async function acceptCloud(result, { manual = false, startedAtGeneration = generation } = {}) {
    if (!result.exists) {
      revision = 0; remoteRevision = 0; lastUpdatedAt = '';
      persistMetadata(); refreshButtons();
      setMessage('云端尚无数据，点击“保存更新”首次同步全部版本。', dirty ? 'pending' : '');
      return false;
    }
    if (!Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error('云端版本号无效，未替换本机数据。');
    validateDocument(result.document);
    remoteRevision = Math.max(remoteRevision, result.revision);
    refreshButtons();
    const currentGeneration = generation;
    const current = captureDocument();
    const [currentFingerprint, cloudFingerprint] = await Promise.all([fingerprint(current), fingerprint(result.document)]);
    if (generation !== currentGeneration) {
      setMessage('读取期间本机数据已修改，未自动覆盖；请保存或手动加载云端。', 'pending');
      return false;
    }
    if (!manual && (dirty || generation !== startedAtGeneration)) {
      setMessage('云端已有数据；本机有未同步修改，未自动覆盖。可先加载云端，本机内容会独立备份。', 'pending');
      return false;
    }
    if (currentFingerprint === cloudFingerprint) {
      revision = result.revision; baseline = currentFingerprint; lastUpdatedAt = result.updatedAt || '';
      dirty = false; pendingRequest = null; persistMetadata();
      setMessage('全部版本已与云端一致。', 'success');
      return true;
    }
    if (manual && dirty && !confirm('当前电脑有未同步修改。将先保存完整本机备份，再加载云端全部版本，是否继续？')) return false;
    const backupGeneration = generation;
    try { await writeBackup(current, manual ? '手动加载云端前' : '自动加载云端前'); }
    catch (_) { throw new Error('无法保存完整本机备份，未加载云端。请先保留本机数据或使用页面的备份功能。'); }
    if (generation !== backupGeneration || (!manual && dirty)) {
      setMessage('备份期间本机又有修改，已停止加载云端，现有数据保留。', 'pending');
      return false;
    }
    const appliedGeneration = generation;
    const restored = await replaceLocalDocument(result.document);
    revision = result.revision; remoteRevision = result.revision;
    baseline = await fingerprint(restored); lastUpdatedAt = result.updatedAt || '';
    dirty = generation !== appliedGeneration; pendingRequest = null; persistMetadata();
    setMessage(dirty ? '已加载云端，之后的本机修改尚未同步；原本机内容也已备份。'
      : '已加载云端全部版本；原本机内容可从“恢复本机备份”找回。', dirty ? 'pending' : 'success');
    return true;
  }

  async function loadCloud(manual = false) {
    if (loadBusy || saveBusy) return false;
    loadBusy = true; refreshButtons();
    const startedAtGeneration = generation;
    try {
      const result = await apiRequest(API_PATH);
      return await acceptCloud(result, { manual, startedAtGeneration });
    } catch (error) { handleError(error, '加载云端失败'); return false; }
    finally { loadBusy = false; refreshButtons(); }
  }

  async function saveCloud() {
    if (saveBusy) { saveQueued = true; return; }
    await startupCheck;
    if (saveBusy) { saveQueued = true; return; }
    if (!apiBase) { setMessage('云同步正在连接，请稍后再次点击“保存更新”；本机修改仍保留。', 'pending'); return; }
    if (loadBusy) { setMessage('正在读取云端，请稍后再点击“保存更新”；本机修改仍保留。', 'pending'); return; }
    if (!session()) {
      setMessage('修改已保留在当前页面；请登录同步，再点击“保存更新”。', 'pending');
      refreshButtons(); return;
    }
    saveBusy = true; refreshButtons();
    let completed = false;
    try {
      const document = captureDocument();
      const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
      if (bytes > MAX_BYTES) throw new Error('完整数据超过当前云同步容量（19 MiB），未删减任何版本或图片；本机数据仍保留。');
      const sentGeneration = generation;
      const sentFingerprint = await fingerprint(document);
      if (!pendingRequest || pendingRequest.fingerprint !== sentFingerprint || pendingRequest.baseRevision !== revision) {
        pendingRequest = { requestId: crypto.randomUUID(), baseRevision: revision, document, fingerprint: sentFingerprint };
      }
      setMessage('正在保存全部版本到云端…', 'pending');
      const result = await apiRequest(API_PATH, {
        baseRevision: pendingRequest.baseRevision, document: pendingRequest.document, requestId: pendingRequest.requestId
      });
      if (!result.ok || !Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error('云端未返回有效保存结果，请核对后重试。');
      revision = result.revision; remoteRevision = result.revision;
      baseline = sentFingerprint; lastUpdatedAt = result.updatedAt || '';
      pendingRequest = null;
      dirty = generation !== sentGeneration;
      persistMetadata(); completed = true;
      setMessage(dirty ? '本次全部版本已同步；之后新增的修改还需点击“保存更新”。' : '全部版本已同步到云端，其他电脑登录后可加载。', dirty ? 'pending' : 'success');
    } catch (error) {
      if (error.status === 409 || error.code === 'revision_conflict') {
        pendingRequest = null; saveQueued = false;
        remoteRevision = Math.max(remoteRevision, revision + 1);
      }
      handleError(error);
    } finally {
      saveBusy = false; refreshButtons();
      const again = saveQueued && completed;
      saveQueued = false;
      if (again) void saveCloud();
    }
  }

  async function pollCloud() {
    if (!initialized || document.visibilityState === 'hidden' || !session() || saveBusy || loadBusy || pollBusy) return;
    pollBusy = true;
    try {
      const result = await apiRequest(API_PATH + '?metadata=1');
      if (result.exists && Number.isSafeInteger(result.revision) && result.revision > revision) {
        remoteRevision = result.revision;
        setMessage(dirty ? '其他电脑已更新云端，本机也有未同步修改；未覆盖任何数据。'
          : '其他电脑已更新，点击“加载云端”查看最新全部版本。', 'pending');
      }
    } catch (error) { if (error.status === 401) handleError(error); }
    finally { pollBusy = false; refreshButtons(); }
  }

  function element(tag, properties = {}, text) {
    const node = document.createElement(tag);
    Object.assign(node, properties);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function makeInterface() {
    document.querySelectorAll('[data-price-cloud-sync]').forEach(node => node.remove());
    const style = element('style', {}, '#price-cloud-sync{flex-basis:100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 11px;margin-top:5px;border:1px solid #dbe6e8;background:#f7fbfb;border-radius:8px;font-size:11px}#price-cloud-sync-status{flex:1;min-width:180px;color:#536f77}#price-cloud-sync[data-kind=error] #price-cloud-sync-status{color:#a33c36}#price-cloud-sync[data-kind=success] #price-cloud-sync-status{color:#176b62}#price-cloud-sync button{font-size:11px;padding:5px 9px}#price-cloud-sync [hidden]{display:none!important}.price-cloud-dialog label{display:block;margin:14px 0 7px}.price-cloud-dialog input,.price-cloud-dialog select{font:inherit;width:100%;box-sizing:border-box}.price-cloud-dialog .cloud-message{font-size:12px;line-height:1.7;color:#a33c36;min-height:20px}.price-cloud-dialog .cloud-help{font-size:12px;line-height:1.7;color:#647a82}.price-cloud-dialog .cloud-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}');
    const bar = element('div', { id: 'price-cloud-sync' });
    const statusNode = element('span', { id: 'price-cloud-sync-status' }, '正在连接云同步…');
    statusNode.setAttribute('role', 'status'); statusNode.setAttribute('aria-live', 'polite');
    const login = element('button', { type: 'button' }, '登录同步');
    const load = element('button', { type: 'button', hidden: true }, '加载云端');
    const restore = element('button', { type: 'button', hidden: true }, '恢复本机备份');
    bar.append(statusNode, login, load, restore);
    const loginDialog = element('dialog', { className: 'price-cloud-dialog' });
    const loginForm = element('form');
    const password = element('input', { id: 'price-cloud-password', type: 'password', autocomplete: 'current-password', required: true, maxLength: 64 });
    const passwordLabel = element('label', { htmlFor: password.id }, '工作台访问口令');
    const loginMessage = element('p', { className: 'cloud-message' });
    loginMessage.setAttribute('role', 'status');
    const loginCancel = element('button', { type: 'button' }, '取消');
    const loginSubmit = element('button', { type: 'submit', className: 'primary' }, '登录同步');
    const loginActions = element('div', { className: 'cloud-actions' }); loginActions.append(loginCancel, loginSubmit);
    loginForm.append(element('h2', {}, '登录云同步'), element('p', { className: 'cloud-help' }, '使用工作台的同一个口令。登录后可保存和加载全部测算版本。'), passwordLabel, password, loginMessage, loginActions);
    loginDialog.append(loginForm);
    const backupDialog = element('dialog', { className: 'price-cloud-dialog' });
    const backupForm = element('form');
    const backupSelect = element('select', { id: 'price-cloud-backup-select', required: true });
    const backupMessage = element('p', { className: 'cloud-message' }); backupMessage.setAttribute('role', 'status');
    const backupCancel = element('button', { type: 'button' }, '取消');
    const backupSubmit = element('button', { type: 'submit', className: 'primary' }, '恢复所选备份');
    const backupActions = element('div', { className: 'cloud-actions' }); backupActions.append(backupCancel, backupSubmit);
    backupForm.append(element('h2', {}, '恢复本机备份'), element('p', { className: 'cloud-help' }, '备份包含当时全部版本、备注、图片和月度数据。恢复后不会自动覆盖云端，需要再次点击“保存更新”。'), element('label', { htmlFor: backupSelect.id }, '选择备份时间'), backupSelect, backupMessage, backupActions);
    backupDialog.append(backupForm);
    for (const node of [style, bar, loginDialog, backupDialog]) node.dataset.priceCloudSync = '';
    document.head.append(style);
    (document.querySelector('header.top') || document.querySelector('main') || document.body).append(bar);
    document.body.append(loginDialog, backupDialog);
    ui = { bar, status: statusNode, login, load, restore, loginDialog, backupDialog };
    login.addEventListener('click', () => { loginMessage.textContent = ''; password.value = ''; loginDialog.showModal(); password.focus(); });
    loginCancel.addEventListener('click', () => { loginDialog.close(); password.value = ''; });
    loginDialog.addEventListener('cancel', () => { password.value = ''; });
    loginForm.addEventListener('submit', async event => {
      event.preventDefault();
      loginSubmit.disabled = true; loginMessage.textContent = '正在验证…';
      try {
        const result = await apiRequest('/api/login', { password: password.value }, '');
        if (typeof result.token !== 'string' || !result.token || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) throw new Error('服务未返回有效登录信息。');
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: result.token, until: result.expiresAt }));
        password.value = ''; loginDialog.close(); refreshButtons();
        startupCheck = loadCloud(false); await startupCheck;
      } catch (error) { password.value = ''; loginMessage.textContent = error.message; }
      finally { loginSubmit.disabled = false; }
    });
    load.addEventListener('click', () => { void loadCloud(true); });
    restore.addEventListener('click', async () => {
      backupMessage.textContent = '';
      await refreshBackupEntries(); backupSelect.replaceChildren();
      for (const entry of backupEntries) backupSelect.append(element('option', { value: entry.id }, new Date(entry.createdAt).toLocaleString('zh-CN') + ' · ' + entry.reason + ' · ' + entry.versions + ' 个版本'));
      if (backupEntries.length) backupDialog.showModal();
      else setMessage('尚无可恢复的本机备份。', 'pending');
    });
    backupCancel.addEventListener('click', () => backupDialog.close());
    backupForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (loadBusy || saveBusy) return;
      backupSubmit.disabled = true; loadBusy = true; refreshButtons();
      const startedAtGeneration = generation;
      try {
        const restored = await readBackup(backupSelect.value); validateDocument(restored);
        if (!confirm('将恢复所选备份中的全部版本。当前页面内容会另存为备份，云端不会自动改变，是否继续？')) return;
        await writeBackup(captureDocument(), '恢复其他备份前');
        if (generation !== startedAtGeneration) throw new Error('恢复期间本机又有修改，已停止替换。');
        await replaceLocalDocument(restored);
        markDirty(); pendingRequest = null; backupDialog.close();
        setMessage('已恢复本机全部版本备份，尚未同步；请核对后点击“保存更新”。', 'pending');
      } catch (error) { backupMessage.textContent = error.message; }
      finally { backupSubmit.disabled = false; loadBusy = false; refreshButtons(); }
    });
  }

  function installHooks() {
    originalSave = save;
    save = function cloudAwareLocalSave(...arguments_) {
      const result = originalSave.apply(this, arguments_);
      markDirty();
      return result;
    };
    const saveButton = document.getElementById('save');
    const originalClick = saveButton.onclick;
    saveButton.onclick = function cloudAwareSaveClick(event) {
      const result = originalClick.call(this, event);
      void saveCloud();
      return result;
    };
    const inputChanged = event => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('#price-cloud-sync,.price-cloud-dialog')) return;
      if (target.matches('#search,#platform,#owner,#productType,#department,#logicPlatform')) return;
      if (target.matches('input,select,textarea')) markDirty();
    };
    document.addEventListener('input', inputChanged, true);
    document.addEventListener('change', inputChanged, true);
    window.addEventListener('beforeunload', event => {
      if (!dirty && !saveBusy) return;
      persistMetadata();
      event.preventDefault(); event.returnValue = '';
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden') void pollCloud(); });
    window.addEventListener('focus', () => { void pollCloud(); });
    setInterval(() => { void pollCloud(); }, 30000);
  }

  async function initialize() {
    const deadline = Date.now() + 15000;
    while (typeof document.getElementById('save')?.onclick !== 'function') {
      if (Date.now() > deadline) throw new Error('测算表尚未准备完成，请刷新后重试。');
      await delay(40);
    }
    localWorkspaceId = app.workspaceId || 'main';
    metaKey = META_PREFIX + localWorkspaceId;
    try { metadata = JSON.parse(localStorage.getItem(metaKey) || '{}') || {}; } catch (_) { metadata = {}; }
    revision = Number.isSafeInteger(metadata.revision) && metadata.revision >= 0 ? metadata.revision : 0;
    baseline = typeof metadata.baseline === 'string' ? metadata.baseline : '';
    dirty = metadata.dirty === true;
    lastUpdatedAt = typeof metadata.updatedAt === 'string' ? metadata.updatedAt : '';
    makeInterface(); installHooks();
    const initialGeneration = generation;
    const initialFingerprint = await fingerprint(captureDocument());
    if (baseline && initialFingerprint !== baseline) dirty = true;
    if (generation !== initialGeneration) dirty = true;
    persistMetadata(); initialized = true;
    void refreshBackupEntries();
    const response = await fetch('./site-config.json', { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error('无法读取云同步配置，请刷新重试。');
    const config = await response.json();
    const url = new URL(config.authApi);
    if (url.protocol !== 'https:' && !(location.hostname === '127.0.0.1' && url.hostname === '127.0.0.1' && url.protocol === 'http:')) throw new Error('云同步服务需要使用 HTTPS。');
    apiBase = url.href.replace(/\/$/, '');
    if (session()) startupCheck = loadCloud(false);
    else setMessage('登录同步后，点击“保存更新”可将全部版本保存到云端。', dirty ? 'pending' : '');
    refreshButtons();
    await startupCheck;
  }

  function start() {
    initialize().catch(error => { setMessage(error.message, 'error'); refreshButtons(); });
  }

  start();
})();
