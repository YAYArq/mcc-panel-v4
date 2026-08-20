'use strict';

const logger = require('./logger');
const { McsmClient } = require('./mcsm');

/**
 * MCSM 守护（挂机服务器保活）。
 *
 * 结合 mcc-panel 的 automation 思路，针对 mineflayer 挂机假人场景：
 *   - mineflayer 假人自身拥有断线自动重连（AfkBot）；
 *   - 本守护通过 MCSM 面板确保【服务器实例】在线：
 *       1. 周期性检查配置的服务器实例是否为运行中；
 *       2. 实例已停止/崩溃 → 按配置自动 start/restart；
 *       3. 可选：轮询实例日志，命中崩溃关键词(如 "Minecraft crashed")也触发重启。
 *
 * 低占用：单定时器；轮询间隔 pollMs 默认 30s，可调大。
 * 配置示例：
 *   "mcsm": {
 *     "url": "http://127.0.0.1:23333",
 *     "apikey": "你的apikey",
 *     "pollMs": 30000,
 *     "server": {                    // 需守护的服务器实例
 *       "daemonId": "default-node",
 *       "uuid": "00000000-0000-0000-0000-000000000000"
 *     },
 *     "startIfStopped": true,        // 停止时自动 start
 *     "restartOnCrashed": true,      // 日志命中崩溃词自动 restart
 *     "crashKeywords": ["Encountered an unexpected exception", "Server crashed", "has crashed"],
 *     "cooldownMs": 60000            // 两次操作最小间隔
 *   }
 */
class McsmGuard {
  /**
   * @param {object} opts { config: 全局配置 }
   */
  constructor(opts = {}) {
    this.cfg = (opts.config && opts.config.mcsm) || {};
    this.log = logger.scope('mcsm-guard');
    this.client = null;
    this._timer = null;
    this._lastAction = 0;
    this._lastLogTail = '';
    this._running = false;
  }

  get enabled() {
    return !!(this.cfg.enabled !== false && this.cfg.url && this.cfg.apikey && this.cfg.server);
  }

  start() {
    if (!this.enabled) {
      this.log.info('MCSM 守护未启用（需要在 config 中配置 mcsm.url / apikey / server）');
      return;
    }
    try {
      this.client = new McsmClient({ url: this.cfg.url, apikey: this.cfg.apikey, timeoutMs: this.cfg.timeoutMs });
    } catch (e) {
      this.log.error('MCSM 客户端初始化失败:', e.message);
      return;
    }
    this.log.info(`MCSM 守护已启动（服务器 ${this.cfg.server.uuid || '?'}，轮询 ${(this.cfg.pollMs || 30000) / 1000}s）`);
    const pollMs = this.cfg.pollMs || 30000;
    const self = this;
    this._timer = setInterval(() => { self._tick(); }, pollMs);
    if (typeof this._timer.unref === 'function') this._timer.unref?.();
    // 尽快跑一次
    setTimeout(() => { if (!self._running) self._tick(); }, 3000);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async _tick() {
    if (this._running) return;
    this._running = true;
    try {
      const srv = this.cfg.server;
      const status = await this.client.getInstanceStatus(srv.daemonId, srv.uuid);
      const now = Date.now();

      // 1) 实例停止 → 启动
      if (status === 'stop') {
        if (this.cfg.startIfStopped === false) return;
        if (now - this._lastAction < (this.cfg.cooldownMs || 60000)) return;
        this._lastAction = now;
        this.log.warn('检测到服务器已停止，正在启动...');
        const ok = await this.client.instanceAction(srv.daemonId, srv.uuid, 'start');
        this.log.info(ok ? '服务器已发出启动指令' : '启动指令失败');
        return;
      }

      // 2) 崩溃关键词检测（仅当实例状态为运行中但日志异常时）
      if (this.cfg.restartOnCrashed) {
        const log = await this.client.readLog(srv.daemonId, srv.uuid, this.cfg.logSize || 65536);
        const crashKey = (this.cfg.crashKeywords || ['Encountered an unexpected exception', 'crashed']).find((k) => log.includes(k));
        if (crashKey) {
          if (now - this._lastAction < (this.cfg.cooldownMs || 60000)) return;
          this._lastAction = now;
          this.log.warn(`日志命中崩溃关键词「${crashKey}」，正在重启服务器...`);
          const ok = await this.client.instanceAction(srv.daemonId, srv.uuid, 'restart');
          this.log.info(ok ? '服务器已发出重启指令' : '重启指令失败');
        }
      }
    } catch (e) {
      this.log.error(`MCSM 守护轮询出错: ${e.message}`);
    } finally {
      this._running = false;
    }
  }
}

module.exports = { McsmGuard };
