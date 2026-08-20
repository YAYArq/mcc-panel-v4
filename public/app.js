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
    grid.innerHTML = instances.map((i) => `
      <div class="inst-card" data-name="${esc(i.name)}">
        <div class="card-top">
          <span class="card-name">${esc(i.name)}</span>
          <span class="badge ${i.online ? 'online' : 'offline'}">${i.online ? '在线' : '离线'}</span>
        </div>
        <div class="card-meta">${esc(i.username)} @ ${esc(i.host)}:${esc(i.port)}</div>
        <div class="card-cmd">TPA ${i.tpaRules}条 · 定时指令 ${i.scheduledCommands}条 · 动作 ${i.scheduledActions}种${i.online ? ` · 在线 ${fmtDur(i.uptime * 1000)}` : ''}</div>
        <div class="card-actions">
          <button data-act="start" class="btn ${!i.online ? 'on' : ''}">启动</button>
          <button data-act="stop">停止</button>
          <button data-act="restart">重启</button>
          <button data-act="delete" class="btn-danger">删除</button>
          <button data-act="open" class="btn-primary">详情</button>
        </div>
      </div>`).join('');
    grid.querySelectorAll('.inst-card').forEach(card => {
      const name = card.dataset.name;
      card.querySelectorAll('button').forEach(btn => btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'delete') { await delInstance(name); return; }
        if (act === 'open') { openDetail(name); return; }
        await api('/api/instances/' + encodeURIComponent(name) + '/' + act, 'POST');
        load();
      }));
    });
  }

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
    if (t.dataset.tab === 'log') { clearInterval(logTimer); logTimer = setInterval(() => loadDetailLog(), 3000); }
  }));
  function switchTab(tab) {
    document.querySelectorAll('#detail-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    ['tab-status', 'tab-config', 'tab-command', 'tab-log'].forEach(id => $(id).classList.add('hidden'));
    $(tab === 'status' ? 'tab-status' : tab === 'config' ? 'tab-config' : tab === 'command' ? 'tab-command' : 'tab-log').classList.remove('hidden');
  }

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
      return `<span class="vis-idx">#${idx + 1}</span>
        <select class="select vis-select" data-k="type"><option value="swing" ${r.type === 'swing' ? 'selected' : ''}>swing挥臂</option><option value="jump" ${r.type === 'jump' ? 'selected' : ''}>jump跳</option><option value="walk" ${r.type === 'walk' ? 'selected' : ''}>walk走</option><option value="sneak" ${r.type === 'sneak' ? 'selected' : ''}>sneak潜行</option><option value="turn" ${r.type === 'turn' ? 'selected' : ''}>turn转身</option></select>
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
    $('cf-name').value = c.name || '';
    $('cf-host').value = c.host || '';
    $('cf-port').value = c.port || '';
    $('cf-username').value = c.username || '';
    $('cf-auth').value = c.auth || 'offline';
    $('cf-version').value = c.version || '';
    $('cf-acceptTpa').value = String(c.acceptTpa !== false);
    $('cf-host').removeAttribute('disabled');
    tpaRows = ((c.tpa && c.tpa.patterns) || []).map(p => typeof p === 'string' ? { regex: p } : { ...p });
    scmdRows = (c.scheduledCommands || []).map(x => ({ ...x }));
    sactRows = (c.scheduledActions || []).map(x => ({ ...x }));
    renderRows();
    toggleAuthNote();
    $('cf-result').textContent = '';
  }

  function toggleAuthNote() { $('auth-note').hidden = $('cf-auth').value !== 'microsoft'; }
  $('cf-auth').addEventListener('change', toggleAuthNote);

  $('tpa-add').addEventListener('click', () => { tpaRows.push({ regex: '', type: 'tpa', accept: true }); renderRows(); });
  $('scmd-add').addEventListener('click', () => { scmdRows.push({ command: '', every: 600000 }); renderRows(); });
  $('sact-add').addEventListener('click', () => { sactRows.push({ type: 'swing', every: 600000 }); renderRows(); });
  $('tpa-reset').addEventListener('click', () => { tpaRows = []; renderRows(); });

  $('cf-save').addEventListener('click', async () => {
    if (!configCache) return;
    const patch = {
      host: $('cf-host').value.trim(),
      port: Number($('cf-port').value) || 25565,
      username: $('cf-username').value.trim(),
      auth: $('cf-auth').value,
      version: $('cf-version').value.trim() || undefined,
      acceptTpa: $('cf-acceptTpa').value === 'true',
      tpa: { ...(configCache.tpa || {}), patterns: tpaRows.filter(r => r.regex) },
      scheduledCommands: scmdRows.filter(r => r.command),
      scheduledActions: sactRows.filter(r => r.type && r.every)
    };
    const d = await api('/api/instances/' + encodeURIComponent(configCache.name) + '/config', 'PUT', patch);
    $('cf-result').textContent = d.message || (d.error || '');
    $('cf-result').className = 'command-result ' + (d.ok ? 'ok' : 'err');
    await new Promise(r => setTimeout(r, 600));
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
  async function loadDetailLog() {
    if (!currentInstance) return;
    const d = await api('/api/instances/' + encodeURIComponent(currentInstance) + '/logs?limit=200');
    renderLog($('log-box'), (d && d.logs) || [], $('chk-auto').checked);
  }
  function renderLog(boxEl, logs, autoScroll) {
    const html = logs.map(l => {
      const lv = (l.level || 'info').toLowerCase();
      return `<div class="log-line"><span class="time">${fmtTs(l.ts)}</span><span class="bot">${esc(l.bot || '')}</span><span class="lv lv-${lv}">[${lv}]</span>${esc(l.msg)}</div>`;
    }).join('') || '<div class="log-line muted">暂无日志</div>';
    const wasBottom = boxEl.scrollHeight - boxEl.scrollTop - boxEl.clientHeight < 40;
    boxEl.innerHTML = html;
    if (autoScroll && wasBottom) boxEl.scrollTop = boxEl.scrollHeight;
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
    if (sel.value) loadGlobalLog();
  }
  async function loadGlobalLog() {
    const name = $('logs-bot').value;
    if (!name) return;
    const d = await api('/api/instances/' + encodeURIComponent(name) + '/logs?limit=200');
    renderLog($('logs-box'), (d && d.logs) || [], $('logs-auto').checked);
  }
  $('logs-bot').addEventListener('change', loadGlobalLog);

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
