'use strict';

// YAYA bot 面板 前端逻辑（纯 fetch，无框架；样式参考 YAYA MCC BOT v3，粉色 + 白天/黑夜）

(function () {
  const token = new URLSearchParams(location.search).get('token') || '';
  const authHeaders = token ? { 'Authorization': 'Bearer ' + token } : {};
  const qs = () => (token ? '?token=' + encodeURIComponent(token) : '');

  let instances = [];
  let currentInstance = null;
  let logTimer = null;
  let configCache = null; // 当前编辑的配置（未保存态）

  // ---------- 工具 ----------
  async function api(path, method, body) {
    const opts = { method: method || 'GET', headers: { ...authHeaders } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    try { const r = await fetch(path + qs(), opts); return await r.json(); }
    catch (e) { return { ok: false, error: '网络错误' }; }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  function fmtTs(ts) { return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—'; }
  function fmtDur(ms) { const s = Math.floor(ms / 1000); return s >= 86400 ? (s / 86400).toFixed(1) + '天' : s >= 3600 ? (s / 3600).toFixed(1) + '时' : s >= 60 ? (s / 60).toFixed(0) + '分' : s + '秒'; }
  const $ = (id) => document.getElementById(id);

  // ---------- 主题：黑夜 / 白天 ----------
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('btn-theme').textContent = theme === 'dark' ? '🌙 黑夜' : '☀️ 白天';
    try { localStorage.setItem('afk-theme', theme); } catch (e) { /* ignore */ }
  }
  (function initTheme() {
    let t = 'dark';
    try { t = localStorage.getItem('afk-theme') || 'dark'; } catch (e) { /* ignore */ }
    applyTheme(t);
  })();
  $('btn-theme').addEventListener('click', () => {
    const next = (document.documentElement.dataset.theme === 'dark') ? 'light' : 'dark';
    applyTheme(next);
  });

  // ---------- 视图切换 ----------
  function switchView(view) {
    document.querySelectorAll('.main-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    ['sec-instances', 'sec-detail', 'sec-health', 'sec-logs', 'sec-config'].forEach(id => { if ($(id)) $(id).classList.add('hidden'); });
    if (view === 'instances') $(view === 'instances' ? 'sec-instances' : '').classList.remove('hidden');
    else if (view === 'detail') $('sec-detail').classList.remove('hidden');
    else if (view === 'health') { $('sec-health').classList.remove('hidden'); loadHealth(); }
    else if (view === 'logs') { $('sec-logs').classList.remove('hidden'); refreshLogsBot(); }
    else if (view === 'config') { $('sec-config').classList.remove('hidden'); loadConfig(); }
  }
  document.querySelectorAll('.main-tab').forEach(t => t.addEventListener('click', () => {
    if (t.dataset.view === 'instances') { switchView('instances'); load(); }
    else if (t.dataset.view === 'health') { switchView('health'); }
    else if (t.dataset.view === 'logs') { switchView('logs'); }
    else if (t.dataset.view === 'config') { switchView('config'); }
  }));

  // ---------- 实例列表 ----------
  async function load() {
    const d = await api('/api/instances');
    instances = (d && d.instances) || [];
    const online = instances.filter(i => i.online).length;
    document.getElementById('h-instances').textContent = instances.length;
    document.getElementById('h-online').textContent = online;
    document.getElementById('h-offline').textContent = instances.length - online;
    document.getElementById('h-tpa').textContent = instances.reduce((s, i) => s + (i.tpaRules || 0), 0);
    const grid = $('instance-grid');
    $('list-summary').textContent = `${instances.length} 个实例 · ${online} 在线`;
    $('empty-state').classList.toggle('hidden', instances.length > 0);
    if (!instances.length) { grid.innerHTML = ''; return; }
    grid.innerHTML = instances.map(createCardHtml).join('');
  }

  // ---- 实例操作按钮（重构：集中定义，按在线状态联动可用性）----
  function actionButtons(inst) {
    const online = !!inst.online;
    const btn = (act, label, cls, enabled, title) =>
      `<button type="button" class="btn ${cls || ''}${!enabled ? ' is-disabled' : ''}" data-act="${act}"
        ${enabled ? '' : 'disabled'} title="${title || label}">${label}</button>`;
    return [
      btn('start', '启动', online ? '' : 'on', !online, online ? '已在运行' : '启动该实例'),
      btn('stop', '停止', '', online, online ? '停止该实例' : '未运行'),
      btn('restart', '重启', '', online, online ? '重启该实例' : '未运行'),
      btn('open', '详情', 'btn-primary', true, '查看详情 / 配置 / 日志'),
      btn('delete', '删除', 'btn-danger', true, '删除该实例（不可恢复）')
    ].join('');
  }

  function createCardHtml(inst) {
    const online = !!inst.online;
    return `
      <div class="inst-card" data-name="${esc(inst.name)}">
        <div class="card-top">
          <span class="card-name">${esc(inst.name)}</span>
          <span class="badge ${online ? 'online' : 'offline'}">${online ? '在线' : '离线'}</span>
        </div>
        <div class="card-meta">${esc(inst.username)} @ ${esc(inst.host)}:${esc(inst.port)}</div>
        <div class="card-cmd">TPA ${inst.tpaRules}条 · 定时指令 ${inst.scheduledCommands}条 · 动作 ${inst.scheduledActions}种${online ? ` · 在线 ${fmtDur(inst.uptime * 1000)}` : ''}</div>
        <div class="card-actions" data-opbar>${actionButtons(inst)}</div>
      </div>`;
  }

  // 事件委托：实例卡片上的操作按钮统一走这里（渲染时无需逐卡逐按钮绑定）
  async function handleInstanceAction(btn) {
    const card = btn.closest('.inst-card');
    const name = card && card.dataset.name;
    if (!name) return;
    const act = btn.dataset.act;
    if (act === 'open') { openDetail(name); return; }
    if (act === 'delete') { await delInstance(name); return; }

    // 启动/停止/重启：请求期间禁用该卡所有操作按钮，避免连点
    const bar = card.querySelector('[data-opbar]');
    if (bar) bar.classList.add('busy');
    try {
      btn.textContent = btn.textContent + '…';
      const d = await api('/api/instances/' + encodeURIComponent(name) + '/' + act, 'POST');
      if (!d.ok && d.message) console.warn(name, act, d.message);
    } finally {
      if (bar) bar.classList.remove('busy');
      load();
    }
  }
  $('instance-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    handleInstanceAction(btn);
  });

  async function delInstance(name) {
    if (!confirm(`确定删除实例「${name}」？此操作会停止并移除该实例。`)) return;
    const d = await api('/api/instances/' + encodeURIComponent(name), 'DELETE');
    alert(d.message || d.error || '已删除');
    load();
  }

  // ---------- 详情 ----------
  function openDetail(name) {
    currentInstance = name;
    $('detail-title').textContent = name + ' · 实例详情';
    switchView('detail');
    switchTab('status');
    renderStatus();
  }
  document.querySelectorAll('#detail-tabs .tab').forEach(t => t.addEventListener('click', () => {
    switchTab(t.dataset.tab);
    if (t.dataset.tab === 'config') loadConfigTab();
    if (t.dataset.tab === 'inventory') loadInventory();
    if (t.dataset.tab === 'log') { clearInterval(logTimer); logTimer = setInterval(() => loadDetailLog(), 3000); }
  }));
  function switchTab(tab) {
    document.querySelectorAll('#detail-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    ['tab-status', 'tab-inventory', 'tab-config', 'tab-command', 'tab-log'].forEach(id => $(id).classList.add('hidden'));
    $(tab === 'status' ? 'tab-status' : tab === 'inventory' ? 'tab-inventory' : tab === 'config' ? 'tab-config' : tab === 'command' ? 'tab-command' : 'tab-log').classList.remove('hidden');
  }

  // ---------- 背包查看与调整 ----------
  async function loadInventory() {
    if (!currentInstance) return;
    const d = await api('/api/instances/' + encodeURIComponent(currentInstance) + '/inventory');
    if (!d.ok) { $('inv-hint').textContent = d.message || '无法读取背包（实例可能离线）'; $('inv-hotbar').innerHTML = ''; $('inv-main').innerHTML = ''; $('inv-status').textContent = ''; return; }
    $('inv-hint').textContent = d.windowName || '';
    $('inv-status').textContent = '' ;
    const slots = d.slots || [];
    // 快捷栏：常为槽位末尾 9 个(背包窗口)或按 mineflayer 布局；这里对含多于 9 的窗口，取最可能为快捷栏的槽
    renderInvSlots(slots);
  }
  function slotCell(s) {
    if (!s || s.empty === true) return '<div class="inv-cell inv-empty"></div>';
    const hasDrop = s.count > 0;
    const img = s.icon
      ? `<img class="inv-icon" src="${esc(s.icon)}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : '';
    return `<div class="inv-cell" data-slot="${s.slot}">
      ${img}
      <div class="inv-item">${esc(s.displayName || s.name)}</div>
      ${s.count > 1 ? `<div class="inv-count">x${esc(s.count)}</div>` : ''}
      ${s.enchanted ? '<div class="inv-ench" title="附魔">✦</div>' : ''}
      <div class="inv-cell-ops">
        <button class="btn btn-sm op-equip" title="装备到主手">拿主手</button>
        ${hasDrop ? '<button class="btn btn-sm op-drop" title="丢出1个">丢</button>' : ''}
      </div>
    </div>`;
  }
  function renderInvSlots(slots) {
    // 快捷栏：mineflayer inventory slots[0..8] 为快捷栏；若非背包窗口则按末尾9格
    const hotbar = slots.slice(0, 9);
    const rest = slots.slice(9);
    $('inv-hotbar').innerHTML = hotbar.map((s, i) => {
      const has = s && s.empty === false;
      const img = has && s.icon ? `<img class="inv-icon" src="${esc(s.icon)}" alt="" loading="lazy" onerror="this.style.display='none'">` : '';
      return `<div class="inv-cell inv-hotbar-cell" data-slot="${s ? s.slot : ''}" data-bar="${i}">
        <span class="inv-bar-idx">${i + 1}</span>
        ${has ? `${img}<div class="inv-item">${esc(s.displayName || s.name)}${s.count > 1 ? ' x' + s.count : ''}</div>` : '<div class="inv-empty"></div>'}
      </div>`;
    }).join('');
    $('inv-main').innerHTML = rest.map(slotCell).join('');
    // 事件：快捷栏点击切主手
    document.querySelectorAll('#inv-hotbar .inv-cell').forEach(c => c.addEventListener('click', () => {
      const bar = c.dataset.bar;
      if (bar !== undefined) doInv('setBar', { index: Number(bar) });
    }));
    // 背包格点击拿主手 / 丢出
    document.querySelectorAll('#inv-main .inv-cell').forEach(c => {
      const slot = c.dataset.slot;
      if (slot === undefined) return;
      const eq = c.querySelector('.op-equip');
      if (eq) eq.addEventListener('click', (e) => { e.stopPropagation(); doInv('equipSlot', { slot: Number(slot) }); });
      const dp = c.querySelector('.op-drop');
      if (dp) dp.addEventListener('click', (e) => { e.stopPropagation(); doInv('drop', { slot: Number(slot), count: 1 }); });
    });
  }
  async function doInv(action, params) {
    if (!currentInstance) return;
    const d = await api('/api/instances/' + encodeURIComponent(currentInstance) + '/inventory', 'POST', { action, ...params });
    $('inv-status').textContent = d.message || (d.error || '');
    $('inv-status').className = 'muted ' + (d.ok ? 'ok' : 'err');
    await new Promise(r => setTimeout(r, 300));
    loadInventory();
  }
  $('inv-refresh').addEventListener('click', loadInventory);


  async function renderStatus() {
    if (!currentInstance) return;
    const d = await api('/api/instances/' + encodeURIComponent(currentInstance));
    const inst = (d && d.instance) || null;
    if (!inst) { $('st-basic').innerHTML = '实例不存在或已被删除'; return; }
    const h = inst.health || {};
    $('st-basic').innerHTML = kv([
      ['实例名', inst.name], ['账号', inst.username], ['服务器', `${inst.host}:${inst.port}`],
      ['状态', inst.online ? '在线' : '离线'], ['本次在线', inst.online ? fmtDur(inst.uptime * 1000) : '—'],
      ['登录方式', '—'], ['最近上线', fmtTs(h.lastOnlineAt)], ['最近离线', fmtTs(h.lastOfflineAt)]
    ]);
    $('st-sched').innerHTML = kv([
      ['TPA 规则数', inst.tpaRules], ['定时指令', inst.scheduledCommands], ['定时动作', inst.scheduledActions]
    ]);
    $('st-result').textContent = '';
  }
  function kv(rows) { return rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join(''); }

  // 详情操作
  $('btn-inst-start').addEventListener('click', () => instAct('start'));
  $('btn-inst-stop').addEventListener('click', () => instAct('stop'));
  $('btn-inst-restart').addEventListener('click', () => instAct('restart'));
  $('btn-inst-delete').addEventListener('click', async () => { if (currentInstance) { await delInstance(currentInstance); switchView('instances'); load(); } });
  async function instAct(action) {
    if (!currentInstance) return;
    const d = await api('/api/instances/' + encodeURIComponent(currentInstance) + '/' + action, 'POST');
    $('st-result').textContent = d.message || (d.error || '');
    $('st-result').className = 'command-result ' + (d.ok ? 'ok' : 'err');
    await new Promise(r => setTimeout(r, 600));
    renderStatus(); load();
  }
  $('btn-back').addEventListener('click', () => switchView('instances'));

  // ---------- 配置编辑：连接 + auth + tpa + 定时任务 ----------
  let tpaRows = [];
  let scmdRows = [];
  let sactRows = [];

  function rowHtml(idx, type) {
    if (type === 'tpa') {
      const r = tpaRows[idx];
      return `<span class="vis-idx">#${idx + 1}</span>
        <input class="input mono-input vis-input" data-k="regex" value="${esc(r.regex)}" placeholder="正则，如：请求传送(到你的位置|到你的身边)">
        <select class="select vis-select" data-k="type"><option value="tpa" ${r.type === 'tpa' ? 'selected' : ''}>tpa</option><option value="tpahere" ${r.type === 'tpahere' ? 'selected' : ''}>tpahere</option><option value="ignore" ${r.type === 'ignore' ? 'selected' : ''}>ignore</option></select>
        <select class="select vis-select" data-k="accept"><option value="true" ${r.accept !== false ? 'selected' : ''}>接受</option><option value="false" ${r.accept === false ? 'selected' : ''} data-r="  ">拒绝</option></select>
        <input class="input mono-input vis-input" data-k="requestCommand" value="${esc(r.requestCommand || '')}" placeholder="接受命令(默认/tpaccept)">
        <button class="btn tpa-del" title="删除该正则">✕</button>`;
    }
    if (type === 'scmd') {
      const r = scmdRows[idx];
      return `<span class="vis-idx">#${idx + 1}</span>
        <input class="input mono-input vis-input" data-k="command" value="${esc(r.command || '')}" placeholder="指令，如 /afk">
        <input class="input mono-input vis-num" data-k="every" value="${esc(r.every || '')}" placeholder="间隔ms">
        <input class="input mono-input vis-input" data-k="cron" value="${esc(r.cron || '')}" placeholder="cron(可选)">
        <button class="btn scmd-del">✕</button>`;
    }
    if (type === 'sact') {
      const r = sactRows[idx];
      const modeHtml = (t) => t === 'rightclick'
        ? `<option value="use" ${r.mode === 'use' || !r.mode ? 'selected' : ''}>用途具/点击</option><option value="place" ${r.mode === 'place' ? 'selected' : ''}>放置方块</option>`
        : `<option value="dig" ${r.mode === 'dig' || !r.mode ? 'selected' : ''}>挖掘</option><option value="attack" ${r.mode === 'attack' ? 'selected' : ''}>攻击</option>`;
      return `<span class="vis-idx">#${idx + 1}</span>
        <select class="select vis-select" data-k="type"><option value="swing" ${r.type === 'swing' ? 'selected' : ''}>swing挥臂</option><option value="jump" ${r.type === 'jump' ? 'selected' : ''}>jump跳</option><option value="walk" ${r.type === 'walk' ? 'selected' : ''}>walk走</option><option value="sneak" ${r.type === 'sneak' ? 'selected' : ''}>sneak潜行</option><option value="turn" ${r.type === 'turn' ? 'selected' : ''}>turn转身</option><option value="rightclick" ${r.type === 'rightclick' ? 'selected' : ''}>rightclick右键</option><option value="leftclick" ${r.type === 'leftclick' ? 'selected' : ''}>leftclick左键</option></select>
        ${(r.type === 'rightclick' || r.type === 'leftclick') ? `<select class="select vis-select" data-k="mode">${modeHtml(r.type)}</select>` : ''}
        <input class="input mono-input vis-num" data-k="every" value="${esc(r.every || '')}" placeholder="间隔ms">
        <input class="input mono-input vis-num" data-k="holdMs" value="${esc(r.holdMs || '')}" placeholder="holdMs(可选)">
        <button class="btn sact-del">✕</button>`;
    }
    return '';
  }
  function renderRows() {
    $('tpa-list').innerHTML = tpaRows.map((_, i) => `<div class="vis-row">${rowHtml(i, 'tpa')}</div>`).join('');
    $('scmd-list').innerHTML = scmdRows.map((_, i) => `<div class="vis-row">${rowHtml(i, 'scmd')}</div>`).join('');
    $('sact-list').innerHTML = sactRows.map((_, i) => `<div class="vis-row">${rowHtml(i, 'sact')}</div>`).join('');
    // 读动态行到数组
    bindRowReads();
  }
  function bindRowReads() {
    document.querySelectorAll('#tpa-list .vis-row').forEach((el, i) => {
      el.querySelectorAll('[data-k]').forEach(inp => inp.addEventListener('input', () => { tpaRows[i][inp.dataset.k] = rawVal(inp); }));
      el.querySelector('.tpa-del').addEventListener('click', () => { tpaRows.splice(i, 1); renderRows(); });
    });
    document.querySelectorAll('#scmd-list .vis-row').forEach((el, i) => {
      el.querySelectorAll('[data-k]').forEach(inp => inp.addEventListener('input', () => { scmdRows[i][inp.dataset.k] = rawVal(inp); }));
      el.querySelector('.scmd-del').addEventListener('click', () => { scmdRows.splice(i, 1); renderRows(); });
    });
    document.querySelectorAll('#sact-list .vis-row').forEach((el, i) => {
      const typeSel = el.querySelector('select[data-k="type"]');
      if (typeSel) typeSel.addEventListener('change', () => { sactRows[i].type = typeSel.value; renderRows(); });
      el.querySelectorAll('[data-k]').forEach(inp => inp.addEventListener('input', () => { sactRows[i][inp.dataset.k] = rawVal(inp); }));
      el.querySelector('.sact-del').addEventListener('click', () => { sactRows.splice(i, 1); renderRows(); });
    });
  }
  function rawVal(inp) {
    if (inp.tagName === 'SELECT') return inp.value;
    if (inp.type === 'number') return inp.value === '' ? undefined : Number(inp.value);
    return inp.value;
  }

  async function loadConfigTab() {
    if (!currentInstance) return;
    const d = await api('/api/instances/' + encodeURIComponent(currentInstance) + '/config');
    configCache = (d && d.config) || {};
    const c = configCache;
    // name 可修改（改名后热重载），还原为原配置名
    $('cf-name').value = c.name || '';
    $('cf-host').value = c.host || '';
    $('cf-port').value = c.port || '';
    $('cf-username').value = c.username || '';
    $('cf-auth').value = c.auth || 'offline';
    $('cf-version').value = c.version || '';
    $('cf-acceptTpa').value = String(c.acceptTpa !== false);
    $('cf-host').removeAttribute('disabled');
    $('cf-wl-only').value = String(c.tpaWhiteListOnly === true);
    $('cf-wl-players').value = Array.isArray(c.tpaWhiteListPlayers) ? c.tpaWhiteListPlayers.join(', ') : '';
    tpaRows = ((c.tpa && c.tpa.patterns) || []).map(p => typeof p === 'string' ? { regex: p } : { ...p });
    scmdRows = (c.scheduledCommands || []).map(x => ({ ...x }));
    sactRows = (c.scheduledActions || []).map(x => ({ ...x }));
    renderRows();
    $('cf-result').textContent = '';
  }

  $('tpa-add').addEventListener('click', () => { tpaRows.push({ regex: '', type: 'tpa', accept: true }); renderRows(); });
  $('scmd-add').addEventListener('click', () => { scmdRows.push({ command: '', every: 600000 }); renderRows(); });
  $('sact-add').addEventListener('click', () => { sactRows.push({ type: 'swing', every: 600000 }); renderRows(); });
  $('tpa-reset').addEventListener('click', () => { tpaRows = []; renderRows(); });

  $('cf-save').addEventListener('click', async () => {
    if (!configCache) return;
    // 白名单玩家：逗号分隔输入解析为数组
    const wlPlayers = ($('cf-wl-players').value || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
    const patch = {
      name: $('cf-name').value.trim() || configCache.name,
      host: $('cf-host').value.trim(),
      port: Number($('cf-port').value) || 25565,
      username: $('cf-username').value.trim(),
      auth: $('cf-auth').value,
      version: $('cf-version').value.trim() || undefined,
      acceptTpa: $('cf-acceptTpa').value === 'true',
      tpaWhiteListOnly: $('cf-wl-only').value === 'true',
      tpaWhiteListPlayers: wlPlayers,
      tpa: { ...(configCache.tpa || {}), patterns: tpaRows.filter(r => r.regex) },
      scheduledCommands: scmdRows.filter(r => r.command),
      scheduledActions: sactRows.filter(r => r.type && r.every)
    };
    const d = await api('/api/instances/' + encodeURIComponent(configCache.name) + '/config', 'PUT', patch);
    $('cf-result').textContent = d.message || (d.error || '');
    $('cf-result').className = 'command-result ' + (d.ok ? 'ok' : 'err');
    await new Promise(r => setTimeout(r, 600));
    if (configCache.name !== patch.name) { currentInstance = patch.name; configCache.name = patch.name; $('detail-title').textContent = patch.name + ' · 实例详情'; }
    load();
  });
  $('cf-discard').addEventListener('click', () => { if (currentInstance) loadConfigTab(); });

  // ---------- 指令 ----------
  $('command-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentInstance) return;
    const cmd = $('command-input').value.trim();
    if (!cmd) return;
    const d = await api('/api/instances/' + encodeURIComponent(currentInstance) + '/command', 'POST', { command: cmd });
    $('cmd-result').textContent = d.message || (d.error || '');
    $('cmd-result').className = 'command-result ' + (d.ok ? 'ok' : 'err');
    $('command-input').value = '';
    refreshCmdHistory();
  });
  async function refreshCmdHistory() { $('command-history').innerHTML = '<div class="row muted">已发送（详见日志）</div>'; }
  // ---------- 日志（增量加载，避免每次全量重渲/不一致） ----------
  const logStates = {}; // { name: { lastSeq } }
  function logLineHtml(l) {
    const lv = (l.level || 'info').toLowerCase();
    return `<div class="log-line" data-seq="${l.seq}"><span class="time">${fmtTs(l.ts)}</span><span class="bot">${esc(l.bot || '')}</span><span class="lv lv-${lv}">[${lv}]</span>${esc(l.msg)}</div>`;
  }
  function renderLogAll(boxEl, logs) {
    boxEl.innerHTML = (logs.map(logLineHtml).join('')) || '<div class="log-line muted">暂无日志</div>';
    boxEl.scrollTop = boxEl.scrollHeight;
  }
  function appendLogLines(boxEl, logs) {
    if (!logs.length) return;
    const wasBottom = boxEl.scrollHeight - boxEl.scrollTop - boxEl.clientHeight < 60;
    const frag = document.createElement('div');
    frag.innerHTML = logs.map(logLineHtml).join('');
    while (frag.firstChild) boxEl.appendChild(frag.firstChild);
    if (wasBottom) boxEl.scrollTop = boxEl.scrollHeight;
  }
  async function pollLog(name, boxEl, autoCheck) {
    const st = logStates[name];
    const first = !st || st.lastSeq == null;
    const url = first
      ? `/api/instances/${encodeURIComponent(name)}/logs?limit=200`
      : `/api/instances/${encodeURIComponent(name)}/logs?limit=100&afterSeq=${st.lastSeq}`;
    const d = await api(url);
    const logs = (d && d.logs) || [];
    if (!first && d.gap) {
      // 缓冲滚动丢段：全量重置
      renderLogAll(boxEl, logs);
    } else if (first) {
      renderLogAll(boxEl, logs);
    } else {
      appendLogLines(boxEl, logs);
    }
    logStates[name] = { lastSeq: (d && d.lastSeq != null) ? d.lastSeq : -1 };
  }
  async function loadDetailLog() {
    if (!currentInstance) return;
    await pollLog(currentInstance, $('log-box'), $('chk-auto'));
  }

  // ---------- 健康监控 ----------
  async function loadHealth() {
    const d = await api('/api/instances');
    const list = (d && d.instances) || [];
    const rows = list.map(i => {
      const h = i.health || {};
      return `<tr>
        <td>${esc(i.name)}</td>
        <td><span class="chip ${i.online ? 'online' : 'offline'}">${i.online ? '在线' : '离线'}</span></td>
        <td class="mono">${fmtDur((h.totalOnlineMs || 0) + (i.online ? (i.uptime || 0) * 1000 : 0))}</td>
        <td class="mono">${i.online ? fmtDur((i.uptime || 0) * 1000) : '—'}</td>
        <td>${h.totalDisconnects || 0}</td>
        <td class="mono">${fmtTs(h.lastOnlineAt)}</td>
        <td class="mono">${fmtTs(h.lastOfflineAt)}</td>
        <td>${esc(h.lastDisconnectReason || '')}</td>
        <td class="mono">${fmtTs(h.startedAt)}</td>
      </tr>`;
    }).join('');
    $('health-box').innerHTML = `
      <table class="v3-table"><thead><tr>
        <th>实例</th><th>状态</th><th>累计在线</th><th>本次在线</th><th>断线</th><th>最近上线</th><th>最近离线</th><th>断线原因</th><th>创建时间</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="9">暂无实例</td></tr>'}</tbody></table>`;
  }
  $('health-refresh').addEventListener('click', loadHealth);

  // ---------- 全局日志 ----------
  async function refreshLogsBot() {
    const sel = $('logs-bot');
    const cur = sel.value;
    sel.innerHTML = instances.map(i => `<option value="${esc(i.name)}">${esc(i.name)}${i.online ? '' : '（离线）'}</option>`).join('');
    if (instances.some(i => i.name === cur)) sel.value = cur;
    if (sel.value) { delete logStates[sel.value]; loadGlobalLog(); }
  }
  async function loadGlobalLog() {
    const name = $('logs-bot').value;
    if (!name) return;
    await pollLog(name, $('logs-box'));
  }
  $('logs-bot').addEventListener('change', () => { if (logStates) { const n = $('logs-bot').value; if (n && logStates[n]) delete logStates[n]; } loadGlobalLog(); });

  // ---------- 配置总览 ----------
  async function loadConfig() {
    const d = await api('/api/config');
    const servers = (d && d.servers) || [];
    const rows = servers.map(s => `<tr>
      <td>${esc(s.name)}</td><td class="mono">${esc(s.username)}</td><td class="mono">${esc(s.host)}:${esc(s.port)}</td>
      <td>${s.auth || 'offline'}</td><td>${s.enabled ? '启用' : '禁用'}</td><td>${s.acceptTpa ? '接取' : '关闭'}</td>
      <td>${s.tpaPatterns}条</td><td>${s.scheduledCommands}</td><td>${s.scheduledActions}</td>
    </tr>`).join('');
    $('config-box').innerHTML = `
      <p class="panel-hint">MCSM 守护：${d && d.mcsmEnabled ? '已启用' : '未启用'}</p>
      <table class="v3-table"><thead><tr>
        <th>实例</th><th>账号</th><th>服务器</th><th>登录方式</th><th>启用</th><th>自动TPA</th><th>TPA规则</th><th>定时指令</th><th>定时动作</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="9">暂无配置</td></tr>'}</tbody></table>`;
  }
  $('config-refresh').addEventListener('click', loadConfig);

  // ---------- 新建实例 modal ----------
  $('btn-add-bot').addEventListener('click', () => { $('modal-add').classList.remove('hidden'); $('na-name').focus(); });
  $('na-cancel').addEventListener('click', () => $('modal-add').classList.add('hidden'));
  $('na-save').addEventListener('click', async () => {
    const body = {
      name: $('na-name').value.trim(),
      host: $('na-host').value.trim(),
      port: Number($('na-port').value) || 25565,
      username: $('na-username').value.trim(),
      auth: $('na-auth').value,
      version: $('na-version').value.trim() || undefined
    };
    if (!body.name || !body.host || !body.username) { alert('name / host / username 必填'); return; }
    const d = await api('/api/instances', 'POST', body);
    alert(d.message || (d.error || ''));
    $('modal-add').classList.add('hidden');
    load();
  });

  // ---------- 启动 ----------
  $('btn-refresh').addEventListener('click', load);
  $('btn-start-all').addEventListener('click', async () => { for (const i of instances) await api('/api/instances/' + encodeURIComponent(i.name) + '/start', 'POST'); load(); });
  $('btn-stop-all').addEventListener('click', async () => { for (const i of instances) await api('/api/instances/' + encodeURIComponent(i.name) + '/stop', 'POST'); load(); });

  load();
  setInterval(load, 5000);
  setInterval(() => { if (currentInstance && !$('sec-detail').classList.contains('hidden') && $('detail-tabs').querySelector('.tab.active') && !$('tab-config').classList.contains('hidden')) { /* 不打扰编辑 */ } }, 1e4);
  // 全局日志自动刷新
  setInterval(() => { if (!$('sec-logs').classList.contains('hidden') && $('logs-auto').checked && $('logs-bot').value) loadGlobalLog(); }, 3000);
  // 健康自动刷新
  setInterval(() => { if (!$('sec-health').classList.contains('hidden')) loadHealth(); }, 5000);
})();
