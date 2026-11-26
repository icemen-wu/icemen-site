(() => {
  'use strict';
  const SESSION_KEY = 'icemen.navigation.access', FAVORITES_KEY = 'icemen.navigation.favorites.v2', LAYOUT_KEY = 'icemen.navigation.layout';
  const $ = id => document.getElementById(id);
  const read = key => { try { return localStorage.getItem(key); } catch (_) { return null; } };
  let modules = [], apiBase = '', configLoaded = false, unlocked = false, activeView = 'home', selectedId = '', token = '';
  let githubConfigured = false, repositoryHead = '', uploadContext = null, uploadBusy = false, publishTimer, publishGeneration = 0, dialogPublishSha = '';
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const ALLOWED_FILES = /\.(html?|pdf|txt|csv|xlsx?|docx|pptx|zip|png|jpe?g|webp|gif)$/i;
  let favorites = new Set(), layout = read(LAYOUT_KEY) === 'grid' ? 'grid' : 'list', toastTimer, sessionTimer, checkingSession = false, sessionUntil = 0, sessionGeneration = 0;
  try { const saved = JSON.parse(read(FAVORITES_KEY) || '[]'); if (Array.isArray(saved)) favorites = new Set(saved.filter(x => typeof x === 'string')); } catch (_) {}
  if (read('icemen.navigation.favorite.price') === 'true' && read(FAVORITES_KEY) === null) favorites.add('price');
  function announce(message) {
    clearTimeout(toastTimer); $('workspace-status').textContent = message; $('workspace-status').hidden = false;
    toastTimer = setTimeout(() => { $('workspace-status').hidden = true; }, 4000);
  }
  function clearPasswordForm() {
    $('password-form').reset(); $('password-message').textContent = '';
    ['current-password', 'new-password', 'confirm-password'].forEach(id => $(id).removeAttribute('aria-invalid'));
  }
  function lock(message = '', success = false) {
    unlocked = false; token = ''; sessionUntil = 0; sessionGeneration++; clearInterval(sessionTimer); clearTimeout(publishTimer); publishGeneration++;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
    $('login-view').hidden = false; $('workspace-view').hidden = true; $('access-form').reset();
    $('access-password').removeAttribute('aria-invalid'); $('access-error').textContent = message;
    $('access-error').classList.toggle('success', success); clearPasswordForm(); $('github-connect-form').reset();
    if ($('upload-dialog').open) $('upload-dialog').close();
    document.title = 'ICEMEN · 工作台';
  }
  async function requestApi(path, body, sessionToken = token, timeoutMs = 15000) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {}; if (body) headers['Content-Type'] = 'application/json'; if (sessionToken) headers.Authorization = 'Bearer ' + sessionToken;
      const response = await fetch(apiBase + path, {method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, cache:'no-store', credentials:'omit', signal:controller.signal});
      let result; try { result = await response.json(); } catch (_) { throw new Error('口令服务返回异常，请稍后重试。'); }
      if (!response.ok) { const error = new Error(result.message || result.error || '服务暂时不可用，请稍后重试。'); error.status = response.status; error.code = result.error; throw error; }
      return result;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('无法连接服务，请检查网络后重试。');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async function checkSession() {
    if (!unlocked) return;
    if (Date.now() >= sessionUntil) { lock('登录已过期，请重新进入。'); return; }
    if (!apiBase || checkingSession) return; checkingSession = true;
    const generation = sessionGeneration, checkedToken = token;
    try { await requestApi('/api/session', undefined, checkedToken); } catch (error) { if (error.status === 401 && unlocked && generation === sessionGeneration && checkedToken === token) lock('口令已更新或登录已过期，请重新进入。'); }
    finally { checkingSession = false; }
  }
  function enter(saved) {
    unlocked = true; token = saved.token || ''; sessionUntil = saved.until; sessionGeneration++;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(saved)); } catch (_) {}
    $('login-view').hidden = true; $('workspace-view').hidden = false; $('access-form').reset(); $('access-error').textContent = ''; route('home');
    clearInterval(sessionTimer); sessionTimer = setInterval(checkSession, 30000);
    refreshGitHubState();
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', '#i-' + name); svg.append(use); return svg;
  }
  function make(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  function normalizeModules(data) {
    if (!Array.isArray(data.modules)) throw new Error('navigation.json 需要包含 modules 数组。');
    const ids = new Set();
    return data.modules.map(item => {
      if (!item || !/^[a-z0-9][a-z0-9-]*$/.test(item.id || '') || ids.has(item.id)) throw new Error('模块 id 需唯一，且仅包含小写字母、数字和连字符。');
      if (typeof item.name !== 'string' || !item.name.trim() || typeof item.path !== 'string' || !item.path.trim()) throw new Error('模块需要填写 name 和 path。');
      const url = new URL(item.path, location.href);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('模块路径必须为网页地址或文件相对路径。');
      ids.add(item.id); return {id:item.id, name:item.name, path:item.path, description:String(item.description || ''), category:String(item.category || '工具与资料'), tags:Array.isArray(item.tags) ? item.tags.filter(x => typeof x === 'string') : []};
    });
  }
  function buildModules() {
    $('module-nav').replaceChildren(); modules.forEach(item => {
      const link = make('a', 'module-item'); link.href = item.path; link.title = item.name; link.append(icon('file'), make('span', 'nav-label', item.name)); $('module-nav').append(link);
    });
  }
  function updateDetails(item) {
    $('detail-name').textContent = item.name; $('detail-description').textContent = item.description; $('detail-open').href = item.path;
    $('detail-location').textContent = item.category; $('detail-filename').textContent = item.path.replace(/^\.\//, '');
    $('detail-tags').replaceChildren(...item.tags.map(tag => make('span', '', tag)));
    const favorite = favorites.has(item.id); $('detail-favorite').classList.toggle('is-favorite', favorite);
    $('detail-favorite').setAttribute('aria-pressed', String(favorite)); $('detail-favorite').setAttribute('aria-label', (favorite ? '取消收藏' : '收藏') + item.name); $('detail-favorite').title = favorite ? '取消收藏' : '收藏';
    $('detail-type').textContent = fileType(item.path);
    $('detail-open').querySelector('span').textContent = /\.html?$/i.test(item.path) ? '打开工具' : '打开文件';
    $('detail-update').disabled = uploadBusy;
  }
  function selectFile(id) { selectedId = id; renderFiles(); $('details-panel').hidden = false; $('details-panel').classList.add('is-open'); }
  function toggleFavorite(id) {
    const next = new Set(favorites); if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next])); favorites = next; renderFiles(); announce(next.has(id) ? '已加入收藏' : '已取消收藏'); }
    catch (_) { announce('浏览器未允许保存收藏，请检查本站存储权限。'); }
  }
  function createRow(item) {
    const row = make('article', 'file-row' + (selectedId === item.id ? ' is-selected' : '')); row.dataset.fileId = item.id; row.setAttribute('aria-label', item.name);
    const nameBox = make('div', 'file-name'), select = make('button', 'file-icon'); select.type = 'button'; select.setAttribute('aria-label', '查看' + item.name + '详情'); select.setAttribute('aria-pressed', String(selectedId === item.id)); select.append(icon('file')); select.addEventListener('click', () => selectFile(item.id));
    const nameText = make('div', 'file-name-text'), link = make('a', 'file-title', item.name); link.href = item.path; nameText.append(link, make('p', 'file-description', item.description)); nameBox.append(select, nameText);
    const star = make('button', 'icon-button favorite-button' + (favorites.has(item.id) ? ' is-favorite' : '')); star.type = 'button'; star.title = favorites.has(item.id) ? '取消收藏' : '收藏'; star.setAttribute('aria-label', (favorites.has(item.id) ? '取消收藏' : '收藏') + item.name); star.setAttribute('aria-pressed', String(favorites.has(item.id))); star.append(icon('star')); star.addEventListener('click', () => toggleFavorite(item.id));
    const actions = make('div', 'file-actions'), update = make('button', 'file-update', '更新');
    update.type = 'button'; update.setAttribute('aria-label', '更新' + item.name); update.disabled = uploadBusy;
    update.addEventListener('click', () => openUpload('update', item.id)); actions.append(update, star);
    row.append(nameBox, make('span', 'file-type', fileType(item.path)), make('span', 'file-location', item.category), actions); row.addEventListener('click', event => { if (!event.target.closest('a,button')) selectFile(item.id); }); return row;
  }
  function renderFiles() {
    const query = $('workspace-search').value.trim().toLocaleLowerCase();
    const visible = modules.filter(item => (activeView !== 'favorites' || favorites.has(item.id)) && [item.name,item.description,item.category,item.path,...item.tags].join(' ').toLocaleLowerCase().includes(query));
    if (!visible.some(item => item.id === selectedId)) selectedId = visible[0]?.id || '';
    $('file-items').replaceChildren(...visible.map(createRow)); $('file-items').dataset.layout = layout; $('file-items').classList.toggle('is-grid', layout === 'grid');
    ['list','grid'].forEach(value => { $('view-' + value).classList.toggle('is-active', layout === value); $('view-' + value).setAttribute('aria-pressed', String(layout === value)); });
    $('clear-search').hidden = !query || activeView === 'settings'; $('result-count').textContent = visible.length + ' 项'; $('list-footer-count').textContent = '共 ' + visible.length + ' 项'; $('empty-state').hidden = visible.length > 0;
    $('empty-title').textContent = query ? '没有找到相关文件' : (activeView === 'favorites' ? '还没有收藏' : '还没有工具'); $('empty-description').textContent = query ? '试试其他关键词。' : (activeView === 'favorites' ? '点击文件旁的星标，把常用工具收藏到这里。' : '在 navigation.json 中添加模块后会显示在这里。');
    $('details-panel').hidden = activeView === 'settings' || !visible.length; const selected = visible.find(item => item.id === selectedId); if (selected) updateDetails(selected);
  }
  function route(view) {
    if (!unlocked) return; activeView = view;
    const labels = {home:['主页','你的常用工具与资料，从这里开始。','快捷访问'], all:['工具与资料','集中访问工作中需要的工具与文件。','全部文件'], favorites:['收藏','把常用工具放在手边。','我的收藏'], settings:['设置','管理工作台的访问口令。','设置']};
    const [title,description,listTitle] = labels[view]; $('page-title').textContent = title; $('page-description').textContent = description; $('breadcrumb-current').textContent = title; $('list-title-label').textContent = listTitle;
    $('files-view').hidden = view === 'settings'; $('settings-view').hidden = view !== 'settings'; $('workspace-search').disabled = view === 'settings'; $('workspace-search').placeholder = view === 'settings' ? '返回工具与资料后搜索' : '搜索工具与资料'; if (view !== 'settings') { clearPasswordForm(); $('github-connect-form').reset(); }
    ['home','all','favorites','settings'].forEach(name => { $('nav-' + name).classList.toggle('is-active', name === view); if (name === view) $('nav-' + name).setAttribute('aria-current','page'); else $('nav-' + name).removeAttribute('aria-current'); });
    document.title = title + ' · ICEMEN 工作台'; renderFiles();
  }
  ['home','all','favorites','settings'].forEach(view => $('nav-' + view).addEventListener('click', () => { $('workspace-search').value = ''; $('details-panel').classList.remove('is-open'); route(view); }));
  $('workspace-search').addEventListener('input', renderFiles); $('clear-search').addEventListener('click', () => { $('workspace-search').value = ''; renderFiles(); $('workspace-search').focus(); });
  document.addEventListener('keydown', event => { if (unlocked && activeView !== 'settings' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('workspace-search').focus(); } if (event.key === 'Escape') $('details-panel').classList.remove('is-open'); });
  ['list','grid'].forEach(value => $('view-' + value).addEventListener('click', () => { layout = value; try { localStorage.setItem(LAYOUT_KEY,layout); } catch (_) {} renderFiles(); }));
  $('detail-close')?.addEventListener('click', () => $('details-panel').classList.remove('is-open')); $('detail-favorite').addEventListener('click', () => { if (selectedId) toggleFavorite(selectedId); });
  $('access-password').addEventListener('input', () => { $('access-password').removeAttribute('aria-invalid'); $('access-error').textContent = ''; $('access-error').classList.remove('success'); });
  $('access-form').addEventListener('submit', async event => {
    event.preventDefault(); const submit = $('access-submit'); if (submit.disabled || !configLoaded) return; submit.disabled = true;
    try {
      const result = await requestApi('/api/login',{password:$('access-password').value},'');
      enter({token:result.token,until:result.expiresAt});
      $('page-title').focus();
    } catch (error) {
      $('access-error').textContent = error.message || '暂时无法进入，请稍后重试。'; $('access-error').classList.remove('success');
      if (error.status === 401) { $('access-password').value = ''; $('access-password').setAttribute('aria-invalid','true'); $('access-password').focus(); }
    } finally { submit.disabled = false; }
  });
  $('access-logout').addEventListener('click', () => { lock(); $('access-password').focus(); });
  function passwordError(id,message) { $(id).setAttribute('aria-invalid','true'); $('password-message').textContent = message; $(id).focus(); }
  ['current-password','new-password','confirm-password'].forEach(id => $(id).addEventListener('input', () => { $(id).removeAttribute('aria-invalid'); $('password-message').textContent = ''; }));
  $('password-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!unlocked || $('password-save').disabled) return;
    if (!apiBase) { $('password-message').textContent = '统一口令服务尚未连接，连接后即可保存。'; return; }
    const next = $('new-password').value; if (next.length < 8 || next.length > 64 || !next.trim()) { passwordError('new-password','新口令需要 8–64 个字符，且不能全为空格。'); return; }
    if (next !== $('confirm-password').value) { passwordError('confirm-password','两次输入的新口令不一致。'); return; }
    $('password-save').disabled = true;
    try { await requestApi('/api/password',{currentPassword:$('current-password').value,newPassword:next}); lock('统一口令已更新，所有设备需使用新口令重新进入。',true); $('access-password').focus(); }
    catch (error) { if (error.status === 401) lock('登录已过期，请重新进入后修改口令。'); else $('password-message').textContent = error.message; }
    finally { $('password-save').disabled = false; }
  });
  window.addEventListener('storage', event => { if (event.key === FAVORITES_KEY || event.key === null) { try { const saved = JSON.parse(read(FAVORITES_KEY) || '[]'); favorites = new Set(Array.isArray(saved) ? saved : []); } catch (_) { favorites = new Set(); } if (unlocked) renderFiles(); } });
  window.addEventListener('pageshow', () => { if (unlocked) checkSession(); }); document.addEventListener('visibilitychange', () => { if (!document.hidden && unlocked) checkSession(); });
  function fileType(path) {
    const extension = path.split('.').pop().toLowerCase();
    if (['html','htm'].includes(extension)) return 'HTML 页面';
    if (['png','jpg','jpeg','webp','gif'].includes(extension)) return '图片';
    return ({pdf:'PDF 文档',xlsx:'Excel 表格',xls:'Excel 表格',csv:'CSV 表格',docx:'Word 文档',pptx:'演示文稿',zip:'压缩文件',txt:'文本文件'})[extension] || '文件';
  }
  function fileSize(bytes) { return bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / (1024 * 1024)).toFixed(2) + ' MB'; }
  async function loadRepositoryFiles() {
    const result = await requestApi('/api/files');
    modules = normalizeModules({modules:result.modules}); repositoryHead = result.headSha; buildModules(); renderFiles();
    return result;
  }
  async function refreshGitHubState() {
    const generation = sessionGeneration;
    try {
      const state = await requestApi('/api/github/status');
      if (!unlocked || generation !== sessionGeneration) return;
      githubConfigured = !!state.configured;
      $('github-status').textContent = githubConfigured ? '已连接 icemen-wu/icemen-site' : '尚未连接仓库';
      $('github-connect-submit').textContent = githubConfigured ? '更新连接' : '连接仓库';
      if (githubConfigured) {
        await loadRepositoryFiles();
        let pending; try { pending = JSON.parse(sessionStorage.getItem('icemen.navigation.pendingPublish') || 'null'); } catch (_) {}
        if (pending?.sha) pollPublication(pending.sha, Date.now(), false);
      }
    } catch (error) {
      if (!unlocked || generation !== sessionGeneration) return;
      $('github-status').textContent = '暂时无法读取连接状态';
      $('github-message').textContent = error.message;
    }
  }
  $('github-connect-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!unlocked || $('github-connect-submit').disabled) return;
    $('github-connect-submit').disabled = true; $('github-message').textContent = '正在验证仓库权限…';
    try {
      await requestApi('/api/github/connect', {token:$('github-token').value.trim()}, token, 45000);
      $('github-connect-form').reset(); githubConfigured = true;
      $('github-status').textContent = '已连接 icemen-wu/icemen-site'; $('github-connect-submit').textContent = '更新连接';
      $('github-message').textContent = '连接成功，可以直接上传和更新文件。'; await loadRepositoryFiles();
    } catch (error) {
      $('github-message').textContent = error.message;
      if (error.status === 401) lock('登录已过期，请重新进入。');
    } finally { $('github-connect-submit').disabled = false; }
  });
  async function openUpload(mode, moduleId) {
    if (!unlocked || uploadBusy) return;
    try {
      if (!githubConfigured) {
        const state = await requestApi('/api/github/status'); githubConfigured = !!state.configured;
        if (!githubConfigured) { route('settings'); $('github-message').textContent = '请先连接 GitHub 仓库，之后就能在这里上传文件。'; $('github-token').focus(); return; }
      }
      $('upload-create').disabled = true; await loadRepositoryFiles();
      const item = mode === 'update' ? modules.find(entry => entry.id === moduleId) : null;
      if (mode === 'update' && !item) throw new Error('文件入口已变更，请刷新列表后重试。');
      clearTimeout(publishTimer); publishGeneration++; dialogPublishSha = '';
      uploadContext = {mode, moduleId, expectedHead:repositoryHead, requestId:crypto.randomUUID(), item};
      $('upload-form').reset(); $('upload-title').textContent = mode === 'update' ? '更新文件' : '上传文件';
      $('upload-target').textContent = item ? '将替换：' + item.name + '（' + item.path.replace(/^\.\//,'') + '）' : '选择文件并填写名称，发布后会自动添加到导航。';
      $('upload-metadata').hidden = mode === 'update'; $('upload-metadata').querySelectorAll('input,textarea,select').forEach(input => { input.disabled = mode === 'update'; });
      $('upload-category').value = '经营工具'; $('upload-file-info').textContent = '';
      $('upload-message').textContent = ''; $('upload-progress').hidden = true; $('upload-deploy-link').hidden = true;
      $('upload-submit').textContent = mode === 'update' ? '更新并发布' : '上传并发布';
      $('upload-submit').disabled = false; $('upload-cancel').disabled = false; $('upload-close').disabled = false;
      $('upload-dialog').showModal();
    } catch (error) { announce(error.message); if (error.status === 401) lock('登录已过期，请重新进入。'); }
    finally { $('upload-create').disabled = false; }
  }
  $('upload-create').addEventListener('click', () => openUpload('create'));
  $('detail-update').addEventListener('click', () => { if (selectedId) openUpload('update',selectedId); });
  ['upload-cancel','upload-close'].forEach(id => $(id).addEventListener('click', () => { if (!uploadBusy) $('upload-dialog').close(); }));
  $('upload-dialog').addEventListener('cancel', event => { if (uploadBusy) event.preventDefault(); });
  function resetRequestId() { if (uploadContext) uploadContext.requestId = crypto.randomUUID(); }
  ['upload-name','upload-description','upload-category'].forEach(id => $(id).addEventListener('input',resetRequestId));
  $('upload-file').addEventListener('change', () => {
    resetRequestId(); const file = $('upload-file').files[0]; $('upload-message').textContent = '';
    $('upload-file-info').textContent = file ? file.name + ' · ' + fileSize(file.size) : '';
    if (file && uploadContext?.mode === 'create' && !$('upload-name').value) $('upload-name').value = file.name.replace(/\.[^.]+$/,'');
  });
  function readFileBase64(file) {
    return new Promise((resolve,reject) => {
      const reader = new FileReader(); reader.onerror = () => reject(new Error('文件读取失败，请重新选择。'));
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.readAsDataURL(file);
    });
  }
  function publicationMessage(message, finished = false, sha = '') {
    if ($('upload-dialog').open && sha === dialogPublishSha) { $('upload-message').textContent = message; $('upload-progress').hidden = false; if (finished) $('upload-progress').value = 100; else $('upload-progress').removeAttribute('value'); }
    else announce(message);
  }
  async function pollPublication(sha, startedAt, interactive = true, generation = publishGeneration, session = sessionGeneration) {
    clearTimeout(publishTimer); if (!unlocked || generation !== publishGeneration || session !== sessionGeneration) return;
    try {
      const result = await requestApi('/api/publish-status?sha=' + encodeURIComponent(sha));
      if (!unlocked || generation !== publishGeneration || session !== sessionGeneration) return;
      if (result.url && dialogPublishSha === sha) { $('upload-deploy-link').href = result.url; $('upload-deploy-link').hidden = false; }
      if (result.status === 'success') {
        try { if (JSON.parse(sessionStorage.getItem('icemen.navigation.pendingPublish') || 'null')?.sha === sha) sessionStorage.removeItem('icemen.navigation.pendingPublish'); } catch (_) {}
        publicationMessage('发布完成，现在可以打开最新文件。',true,sha); return;
      }
      if (result.status === 'failure') { publicationMessage('文件已保存到仓库，但网站发布失败。请查看发布记录。',true,sha); return; }
      if (Date.now() - startedAt > 5 * 60 * 1000) { publicationMessage('文件已保存，网站仍在发布中，请稍后刷新或查看发布记录。',false,sha); return; }
      if (interactive) publicationMessage('文件已保存，正在发布到网站…',false,sha);
      publishTimer = setTimeout(() => pollPublication(sha,startedAt,interactive,generation,session),5000);
    } catch (error) { if (generation === publishGeneration && session === sessionGeneration && unlocked) publicationMessage('文件已保存；暂时无法读取发布进度，请稍后刷新网站。',false,sha); }
  }
  $('upload-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!uploadContext || uploadBusy || !unlocked) return;
    const file = $('upload-file').files[0];
    if (!file) { $('upload-message').textContent = '请先选择文件。'; return; }
    if (!file.size || file.size > MAX_FILE_BYTES) { $('upload-message').textContent = '请选择非空且不超过 10 MB 的文件。'; return; }
    if (!ALLOWED_FILES.test(file.name)) { $('upload-message').textContent = '暂不支持这个文件格式，请选择 HTML、PDF、文档、图片或 ZIP 文件。'; return; }
    if (uploadContext.mode === 'update') {
      const targetExtension = uploadContext.item.path.split('.').pop().toLowerCase(), selectedExtension = file.name.split('.').pop().toLowerCase();
      if (targetExtension !== selectedExtension) { $('upload-message').textContent = '请选择与原文件格式相同的文件（.' + targetExtension + '）。'; return; }
    }
    const context = {...uploadContext}, generation = sessionGeneration;
    uploadBusy = true; $('upload-submit').disabled = true; $('upload-cancel').disabled = true; $('upload-close').disabled = true;
    $('upload-progress').hidden = false; $('upload-progress').removeAttribute('value'); $('upload-message').textContent = '正在读取文件…';
    $('upload-form').querySelectorAll('input,textarea').forEach(input => { input.disabled = true; });
    try {
      const contentBase64 = await readFileBase64(file); $('upload-message').textContent = '正在上传并保存到仓库…';
      const result = await requestApi('/api/files/upload',{
        mode:context.mode,moduleId:context.moduleId,filename:file.name,contentBase64,
        ...(context.mode === 'create' ? {name:$('upload-name').value.trim(),description:$('upload-description').value.trim(),category:$('upload-category').value.trim()} : {}),
        expectedHead:context.expectedHead,requestId:context.requestId
      },token,120000);
      if (!unlocked || generation !== sessionGeneration) return;
      dialogPublishSha = result.sha; publishGeneration++;
      try { sessionStorage.setItem('icemen.navigation.pendingPublish',JSON.stringify({sha:result.sha})); } catch (_) {}
      $('upload-deploy-link').href = 'https://github.com/icemen-wu/icemen-site/actions'; $('upload-deploy-link').hidden = false;
      $('upload-submit').textContent = '已保存'; $('upload-submit').disabled = true; uploadContext = null;
      try { await loadRepositoryFiles(); } catch (_) { announce('文件已保存，稍后刷新列表即可查看。'); }
      if (result.module?.id) selectedId = result.module.id; renderFiles();
      pollPublication(result.sha,Date.now());
    } catch (error) {
      if (error.status === 401) { lock('登录已过期，请重新进入后上传。'); return; }
      $('upload-message').textContent = error.message;
      if (error.status === 409) {
        try {
          await loadRepositoryFiles();
          if (uploadContext?.mode === 'update') {
            const latest = modules.find(item => item.id === uploadContext.moduleId);
            if (!latest || latest.path !== uploadContext.item.path) { uploadContext = null; $('upload-message').textContent = '目标文件路径已被修改，请关闭弹窗后重新选择要更新的文件。'; }
            else uploadContext.item = latest;
          }
          if (uploadContext) { uploadContext.expectedHead = repositoryHead; uploadContext.requestId = crypto.randomUUID(); }
        } catch (_) {}
        $('upload-message').textContent += ' 请核对后再次提交。';
      }
      $('upload-progress').hidden = true; $('upload-submit').disabled = !uploadContext;
    } finally {
      uploadBusy = false; $('upload-cancel').disabled = false; $('upload-close').disabled = false;
      $('upload-form').querySelectorAll('input,textarea').forEach(input => { input.disabled = false; });
      if (context.mode === 'update') $('upload-metadata').querySelectorAll('input,textarea,select').forEach(input => { input.disabled = true; });
      if (unlocked) renderFiles();
    }
  });
  async function initialize() {
    try {
      const [navigationResponse,siteResponse] = await Promise.all([fetch('./navigation.json',{cache:'no-store'}),fetch('./site-config.json',{cache:'no-store'})]);
      if (!navigationResponse.ok || !siteResponse.ok) throw new Error('无法读取网站配置，请刷新重试。');
      modules = normalizeModules(await navigationResponse.json()); const config = await siteResponse.json();
      if (!config.authApi) throw new Error('尚未配置统一口令服务。');
      if (config.authApi) { const url = new URL(config.authApi); if (url.protocol !== 'https:' && !(location.hostname === '127.0.0.1' && url.hostname === '127.0.0.1' && url.protocol === 'http:')) throw new Error('口令服务需要使用 HTTPS。'); apiBase = url.href.replace(/\/$/,''); }
      configLoaded = true; buildModules(); $('password-scope-note').textContent = apiBase ? '修改后，所有设备统一使用新口令，并需要重新登录。' : '统一口令服务待连接，连接后可修改所有设备共用的口令。';
      let saved; try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (_) {}
      if (saved?.until > Date.now()) {
        if (apiBase && saved.token) { try { await requestApi('/api/session',undefined,saved.token); enter(saved); } catch (error) { lock(error.status === 401 ? '' : error.message); } }
        else lock();
      } else lock(); $('access-submit').disabled = false;
    } catch (error) { $('access-error').textContent = '加载失败：' + error.message; $('access-submit').disabled = true; }
  }
  initialize();
})();
