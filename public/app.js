'use strict';

// 挂机假人面板 前端逻辑（纯 fetch，无框架；样式参考 YAYA MCC BOT v3）

(function () {
  // 从 URL 取鉴权 token（若面板启用了 PANEL_TOKEN）
  const token = new URLSearchParams(location.search).get('token') || '';
  const authHeaders = token ? { 'Authorization': 'Bearer ' + token } : {};
  const qs = () => (token ? '?token=' + encodeURIComponent(token) : '');

  let instances = [];
  let currentInstance = null;   // 详情中的实例名
  let logTimer = null;
  let logsTimer = null;

  // ---------- 基础工具 ----------
  async function api(path, method, body) {
    const opts = { method: method || 'GET', headers: authHeaders };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    try {
      const res = await fetch(path + qs(), opts);
      return await res.json();
    } catch (e) {
      return { ok: false, error: '网络错误' };
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }
  function fmtTs(ts) { return ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : ''; }
  function $(id) { return document.getElementById(id); }

  // ---------- 视图切换 ----------
  function switchView(view, ev) {
    document.querySelectorAll('.main-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    ['sec-instances', 'sec-detail', 'sec-logs', 'sec-config'].forEach(id => $(id).classList.add('hidden'));
    if (view === 'instances') { $('sec-instances').classList.remove('hidden'); }
    else if (view === 'detail') { $('sec-detail').classList.remove('hidden'); }
    else if (view === 'logs') { $('sec-logs').classList.remove('hidden'); refreshLogsBot(); }
    else if (view === 'config') { $('sec-config').classList.remove('hidden'); loadConfig(); }
    if (ev) { currentInstance = null; clearInterval(logTimer); }
  }
  document.querySelectorAll('.main-tab').forEach(t =>
    t.addEventListener('click', (e) => {
      if (t.dataset.view === 'instances') { switchView('instances'); load(); }
      else switchView(t.dataset.view);
    })
  );

  // ---------- 实例列表 ----------
  async function load() {
    const d = await api('/api/instances');
    instances = (d && d.instances) || [];
    renderHero();
    renderGrid();
  }
  function renderHero() {
    const online = instances.filter(i => i.online).length;
    const tpa = instances.reduce((s, i) => s + (i.tpaRules || 0), 0);
    $('h-instances').textContent = instances.length;
    $('h-online').textContent = online;
    $('h-offline').textContent = instances.length - online;
    $('h-tpa').textContent = tpa;
  }
  function renderGrid() {
    const grid = $('instance-grid');
    $('list-summary').textContent = `${instances.length} 个实例 · ${instances.filter(i => i.online).length} 在线`;
    $('empty-state').classList.toggle('hidden', instances.length > 0);
    if (!instances.length) return;
    grid.innerHTML = instances.map((i) => `
      <div class="inst-card" data-name="${esc(i.name)}">
        <div class="card-top">
          <span class="card-name">${esc(i.name)}</span>
          <span class="badge ${i.online ? 'online' : 'offline'}">${i.online ? '在线' : '离线'}</span>
        </div>
        <div class="card-meta">${esc(i.username)} @ ${esc(i.host)}:${esc(i.port)}</div>
        <div class="card-cmd">TPA ${i.tpaRules}条 · 定时指令 ${i.scheduledCommands}条 · 动作 ${i.scheduledActions}种${i.online ? ` · 在线 ${i.uptime}s` : ' · ' + (i.reconnectAttempts ? `${i.reconnectAttempts}次重连` : '未启动')}</div>
        <div class="card-actions">
          <button data-act="start" class="btn ${!i.online ? 'on' : ''}">启动</button>
          <button data-act="stop">停止</button>
          <button data-act="restart">重启</button>
          <button data-act="open">详情</button>
        </div>
      </div>`).join('');
    grid.querySelectorAll('.inst-card').forEach(card => {
      const name = card.dataset.name;
      card.querySelectorAll('button').forEach(btn => btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'open') { openDetail(name); return; }
        await api('/api/instances/' + encodeURIComponent(name) + '/' + act, 'POST');
        load();
      }));
      card.addEventListener('dblclick', () => openDetail(name));
    });
  }

  // ---------- 详情 ----------
  function openDetail(name) {
    currentInstance = name;
    $('detail-title').textContent = name + ' · 实例详情';
    switchView('detail');
    switchTab('status');
    renderDetail();
  }
  document.querySelectorAll('#detail-tabs .tab').forEach(t =>
    t.addEventListener('click', () => switchTab(t.dataset.tab)));
  function switchTab(tab) {
    document.querySelectorAll('#detail-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    ['tab-status', 'tab-command', 'tab-log'].forEach(id => $(id).classList.add('hidden'));
    $(tab === 'status' ? 'tab-status' : tab === 'command' ? 'tab-command' : 'tab-log').classList.remove('hidden');
  }
  async function renderDetail() {
    if (!currentInstance) return;
    const d = await api('/api/instances/' + encodeURIComponent(currentInstance));
    const i = (d && d.instance) || null;
    if (!i) { $('st-basic').innerHTML = '实例不存在'; return; }
    $('st-basic').innerHTML = kv([
      ['实例名', i.name], ['账号', i.username], ['服务器', `${i.host}:${i.port}`],
      ['状态', i.online ? '在线' : '离线'], ['在线时长', i.online ? i.uptime + 's' : '—'],
      ['重连次数', i.reconnectAttempts]
    ]);
    $('st-sched').innerHTML = kv([
      ['TPA 规则数', i.tpaRules], ['定时指令', i.scheduledCommands], ['定时动作', i.scheduledActions]
    ]);
    $('st-result').textContent = '';
    // 初始化指令历史
    renderCmdHistory([], d.latestLogs || []);
    // 日志
    clearInterval(logTimer);
    loadDetailLog(i);
    logTimer = setInterval(() => loadDetailLog(i), 3000);
  }
  function kv(rows) {
    return rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join('');
  }

  // 详情操作
  $('btn-inst-start').addEventListener('click', () => act('start'));
  $('btn-inst-stop').addEventListener('click', () => act('stop'));
  $('btn-inst-restart').addEventListener('click', () => act('restart'));
  async function act(action) {
    if (!currentInstance) return;
    const d = await api('/api/instances/' + encodeURIComponent(currentInstance) + '/' + action, 'POST');
    $('st-result').textContent = d.message || (d.error || '');
    $('st-result').className = 'command-result ' + (d.ok ? 'ok' : 'err');
    await new Promise(r => setTimeout(r, 600));
    renderDetail();
    load();
  }
  $('btn-back').addEventListener('click', () => switchView('instances'));

  // 指令
  let cmdHistory = [];
  async function loadDetailLog(inst) {
    const d = await api('/api/instances/' + encodeURIComponent(inst.name) + '/logs?limit=200');
    const logs = (d && d.logs) || [];
    renderLog($('log-box'), logs, $('chk-auto').checked);
  }
  $('command-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentInstance) return;
    const cmd = $('command-input').value.trim();
    if (!cmd) return;
    const d = await api('/api/instances/' + encodeURIComponent(currentInstance) + '/command', 'POST', { command: cmd });
    $('cmd-result').textContent = d.message || (d.error || '');
    $('cmd-result').className = 'command-result ' + (d.ok ? 'ok' : 'err');
    cmdHistory.unshift({ cmd, out: d.message || (d.error || ''), ok: d.ok });
    renderCmdHistory(cmdHistory);
    $('command-input').value = '';
  });
  function renderCmdHistory(hist, latest) {
    const list = hist.slice(0, 50).map(h =>
      `<div class="row"><span class="out">→</span> ${esc(h.cmd)} <span class="out">${esc(h.out || '')}</span></div>`).join('');
    $('command-history').innerHTML = list || '<div class="row muted">暂无指令记录</div>';
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
  $('logs-bot') && $('logs-bot').addEventListener('change', loadGlobalLog);
  setInterval(() => { if (!$('sec-logs').classList.contains('hidden') && $('logs-auto').checked && $('logs-bot').value) loadGlobalLog(); }, 3000);

  // ---------- 配置 ----------
  async function loadConfig() {
    const d = await api('/api/config');
    const servers = (d && d.servers) || [];
    const rows = servers.map(s => `<tr>
      <td>${esc(s.name)}</td>
      <td class="mono">${esc(s.username)}</td>
      <td class="mono">${esc(s.host)}:${esc(s.port)}</td>
      <td>${s.enabled ? '启用' : '禁用'}</td>
      <td>${s.acceptTpa ? '接取' : '关闭'}</td>
      <td>${s.tpaPatterns}条</td>
      <td>${s.scheduledCommands}</td>
      <td>${s.scheduledActions}</td>
    </tr>`).join('');
    $('config-box').innerHTML = `
      <p class="panel-hint">MCSM 守护：${d && d.mcsmEnabled ? '已启用' : '未启用'}</p>
      <table class="v3-table"><thead><tr>
        <th>实例</th><th>账号</th><th>服务器</th><th>状态</th><th>自动TPA</th><th>TPA规则</th><th>定时指令</th><th>定时动作</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="8">暂无配置</td></tr>'}</tbody></table>`;
  }
  $('config-refresh') && $('config-refresh').addEventListener('click', loadConfig);

  // ---------- 工具栏 ----------
  $('btn-refresh').addEventListener('click', load);
  $('btn-start-all').addEventListener('click', async () => {
    for (const i of instances) { if (!i.online) await api('/api/instances/' + encodeURIComponent(i.name) + '/start', 'POST'); }
    load();
  });
  $('btn-stop-all').addEventListener('click', async () => {
    for (const i of instances) { if (i.online) await api('/api/instances/' + encodeURIComponent(i.name) + '/stop', 'POST'); }
    load();
  });

  // ---------- 启动 ----------
  load();
  setInterval(load, 5000); // 5s 自动刷新实例状态
  setInterval(() => { if (currentInstance && !$('sec-detail').classList.contains('hidden')) renderDetail(); }, 8000);
})();
