'use strict';

// 独立 Web 面板（零第三方依赖，统一端口 10270）。
// 负责：静态面板页面 + REST API（实例状态 / 单独启停 / 发指令 / 日志），并提供 /health 健康检查。
// 低占用：仅一个 Node 内置 http 服务器；面板对端口占用极小，不影响挂机假人主流程。
//
// 安全：
//   - 默认监听 0.0.0.0（依赖云安全组控制公网访问）；可用环境变量 PANEL_HOST 覆盖，如 127.0.0.1。
//   - 可选鉴权：设置环境变量 PANEL_TOKEN 后，所有面板请求需带 `?token=<PANEL_TOKEN>` 或 `Authorization: Bearer <PANEL_TOKEN>`。
//
// 路由：
//   GET  /                                前端面板页面
//   GET  /app.js,/app.css                 前端静态资源
//   GET  /health,/healthz                健康检查
//   GET  /status                          实例快照（兼容）
//   GET  /api/instances                   全部实例状态
//   GET  /api/instances/:name             单个实例（含 latestLogs）
//   POST /api/instances/:name/start      单独启动
//   POST /api/instances/:name/stop       单独停止
//   POST /api/instances/:name/restart    单独重启
//   POST /api/instances/:name/command    { "command": "..." } 发指令
//   GET  /api/instances/:name/logs?limit=拉日志

const http = require('http');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { ConfigStore } = require('./configStore');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// 小文件静态资源缓存
const _staticCache = new Map();
function serveStatic(res, file, type) {
  try {
    if (!_staticCache.has(file)) {
      _staticCache.set(file, fs.readFileSync(file));
    }
    const mime = type || (path.extname(file) === '.css' ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
    res.writeHead(200, { 'Content-Type': mime });
    res.end(_staticCache.get(file));
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/** 鉴权校验（PANEL_TOKEN 未设置则放行） */
function checkAuth(req, token) {
  if (!token) return true;
  const q = new URL(req.url, 'http://x').searchParams.get('token');
  if (q && q === token) return true;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ') && h.slice(7) === token) return true;
  return false;
}

/**
 * 创建并启动面板 HTTP 服务器。
 * @param {object} opts { manager, publicDir?, port=10270, token? }
 * @returns {http.Server}
 */
function startPanel(opts = {}) {
  const manager = opts.manager;
  const port = Number(process.env.PORT) || opts.port || 10270;
  const host = process.env.PANEL_HOST || '0.0.0.0';
  const token = opts.token || process.env.PANEL_TOKEN || '';
  const publicDir = opts.publicDir || PUBLIC_DIR;
  const store = new ConfigStore({ configPath: opts.configPath || path.join(__dirname, '..', 'config.json') });

  /** 返回完整可编辑配置（去敏感） */
  function editableConfig(scfg) {
    return {
      name: scfg.name, host: scfg.host, port: scfg.port, username: scfg.username,
      auth: scfg.auth, version: scfg.version || null, enabled: scfg.enabled !== false,
      acceptTpa: scfg.acceptTpa !== false, tpa: scfg.tpa || {},
      scheduledCommands: scfg.scheduledCommands || [], scheduledActions: scfg.scheduledActions || [],
      botOptions: scfg.botOptions || {}
    };
  }

  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);

    if (!checkAuth(req, token)) {
      return json(res, 401, { ok: false, error: 'unauthorized' });
    }

    // 静态面板
    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
      return serveStatic(res, path.join(publicDir, 'index.html'));
    }
    if (req.method === 'GET' && (urlPath === '/app.js' || urlPath === '/app.css')) {
      return serveStatic(res, path.join(publicDir, path.basename(urlPath)));
    }

    // 健康检查 / 状态
    if (req.method === 'GET' && (urlPath === '/health' || urlPath === '/healthz')) {
      return json(res, 200, { ok: true, service: 'afk-bot' });
    }
    if (req.method === 'GET' && urlPath === '/status') {
      return json(res, 200, { ok: true, instances: manager.getSnapshots() });
    }

    // 实例列表
    if (req.method === 'GET' && urlPath === '/api/instances') {
      return json(res, 200, { ok: true, instances: manager.getSnapshots() });
    }

    // 配置概览（脱敏：去除 apikey 等敏感字段）
    if (req.method === 'GET' && urlPath === '/api/config') {
      const servers = ((manager.config && manager.config.servers) || []).map((s) => ({
        name: s.name, host: s.host, port: s.port, username: s.username,
        auth: s.auth, version: s.version || null, enabled: s.enabled !== false,
        acceptTpa: s.acceptTpa !== false, tpaPatterns: (s.tpa && s.tpa.patterns) ? s.tpa.patterns.length : 0,
        scheduledCommands: (s.scheduledCommands || []).length,
        scheduledActions: (s.scheduledActions || []).length
      }));
      return json(res, 200, { ok: true, mcsmEnabled: !!(manager.config && manager.config.mcsm && manager.config.mcsm.enabled), servers });
    }

    // 实例级操作
    const m = /^\/api\/instances\/([^/]+)(?:\/([^/]+))?$/.exec(urlPath);
    if (m) {
      const name = decodeURIComponent(m[1]);
      const action = m[2];

      // POST 控制：start / stop / restart
      if (req.method === 'POST' && ['start', 'stop', 'restart'].includes(action)) {
        const result = manager[action](name) || { ok: false, message: '操作失败' };
        return json(res, result.ok ? 200 : 400, result);
      }

      // POST 发命令
      if (req.method === 'POST' && action === 'command') {
        const body = await readBody(req);
        if (!body.command) return json(res, 400, { ok: false, error: '缺少 command 字段' });
        return json(res, 200, manager.sendCommand(name, body.command));
      }

      // GET 单实例
      if (req.method === 'GET' && !action) {
        const snap = manager.getSnapshots().find((s) => s.name === name) || null;
        if (!snap) return json(res, 404, { ok: false, error: '实例不存在' });
        return json(res, 200, { ok: true, instance: snap, latestLogs: manager.getLogs(name, 60) });
      }

      // GET 日志
      if (req.method === 'GET' && action === 'logs') {
        const limit = Number(new URL(req.url, 'http://x').searchParams.get('limit')) || 100;
        return json(res, 200, { ok: true, logs: manager.getLogs(name, limit) });
      }

      // GET 单实例可编辑配置
      if (req.method === 'GET' && action === 'config') {
        const sc = store.getServer(name);
        if (!sc) return json(res, 404, { ok: false, error: '实例不存在' });
        return json(res, 200, { ok: true, config: editableConfig(sc) });
      }

      // PUT 保存配置并热重载 (body: 可编辑字段)
      if (req.method === 'PUT' && action === 'config') {
        const body = await readBody(req);
        const saved = store.updateServer(name, body);
        if (!saved.ok) return json(res, 400, saved);
        const latest = store.getServer(name);
        const reload = manager.updateServer(name, latest);
        return json(res, reload.ok ? 200 : 400, { ok: true, message: saved.message + (reload.ok ? '，已热重载' : '，但重载失败：' + reload.message) });
      }

      // DELETE 删除实例
      if (req.method === 'DELETE') {
        const removed = store.removeServer(name);
        if (!removed.ok) return json(res, 400, removed);
        manager.removeServer(name);
        return json(res, 200, removed);
      }
    }

    // POST 创建实例 (body: { host, port, username, auth, version, name, ... })
    if (req.method === 'POST' && urlPath === '/api/instances') {
      const body = await readBody(req);
      const created = store.createServer(body);
      if (!created.ok) return json(res, 400, created);
      const added = manager.addServer(created.server);
      return json(res, added.ok ? 200 : 400, { ok: true, message: created.message + (added.ok ? '，已启动' : '，但启动失败：' + added.message) });
    }

    json(res, 404, { ok: false, error: 'not found' });
  });

  server.listen(port, host, () => {
    logger.info(`独立 Web 面板已启动 http://${host}:${port}${token ? ' (已启用 PANEL_TOKEN 鉴权)' : ''}`);
    logger.info('  面板页面: GET /　| 健康检查: GET /health　| 实例API: /api/instances');
  });

  return server;
}

module.exports = { startPanel };
