'use strict';

// 极轻量 HTTP 健康检查 / 状态端点（低占用：仅一个 http server，无第三方依赖）。
// 端口由环境变量 PORT 控制，默认 10270。
// 用途：服务器上 curl http://127.0.0.1:10270/health 确认挂机假人服务存活，
//       getStatusJson 可用于未来扩展管理面板底座。

const http = require('http');
const logger = require('./logger');

/**
 * 启动健康检查 HTTP 服务。
 * @param {object} opts
 * @param {number} [opts.port=10270]
 * @param {() => Array} [opts.getSnapshots] 返回实例状态快照
 * @returns {http.Server}
 */
function startHealthServer({ port, getSnapshots } = {}) {
  const p = Number(process.env.PORT) || port || 10270;
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url === '/health' || url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'afk-bot' }));
      return;
    }
    if (url === '/status' && typeof getSnapshots === 'function') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, instances: getSnapshots() }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found', paths: ['/health', '/status'] }));
  });
  server.listen(p, '0.0.0.0', () => {
    logger.info(`健康检查 HTTP 服务已监听 :${p}（GET /health、/status）`);
  });
  return server;
}

module.exports = { startHealthServer };
