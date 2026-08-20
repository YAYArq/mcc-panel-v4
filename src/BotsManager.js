'use strict';

const logger = require('./logger');
const { AfkBot } = require('./AfkBot');

/**
 * 多挂机假人管理器。
 * 一个进程管理多个 AfkBot 实例，统一启停与状态快照。
 */
class BotsManager {
  /**
   * @param {object} options
   * @param {object} options.config 规范化后的全局配置（含 servers）
   */
  constructor(options = {}) {
    this.config = options.config;
    this.log = logger.scope('mgr');
    this.bots = new Map(); // name -> AfkBot
    this.globalBotOptions = (this.config && this.config.botOptions) || {};
    this.schedulerTickMs = (this.config && this.config.schedulerTickMs) || 1000;
  }

  /** 依据配置创建所有挂机假人实例（不连接） */
  load() {
    for (const scfg of (this.config.servers || [])) {
      if (scfg.enabled === false) {
        this.log.info(`服务器[${scfg.name}] 已在配置中禁用，跳过。`);
        continue;
      }
      if (this.bots.has(scfg.name)) {
        this.log.warn(`服务器名[${scfg.name}] 重复，已跳过。`);
        continue;
      }
      const bot = new AfkBot(scfg, {
        schedulerTickMs: this.schedulerTickMs,
        globalBotOptions: this.globalBotOptions,
        onEvent: (b, event, data) => this._onEvent(b, event, data)
      });
      this.bots.set(scfg.name, bot);
    }
    this.log.info(`已创建 ${this.bots.size} 个挂机假人实例`);
    return this;
  }

  _onEvent(bot, event, data) {
    // 预留：未来可在此接 WebSocket / MCSM 反馈
    this.log.debug(`[${bot.cfg.name}] 事件 ${event}`, data);
  }

  start() {
    for (const bot of this.bots.values()) bot.start();
  }

  stop() {
    for (const bot of this.bots.values()) bot.stop();
  }

  getSnapshots() {
    return [...this.bots.values()].map((b) => b.getStatus());
  }

  getBot(name) {
    return this.bots.get(name) || null;
  }

  /**
   * 单独启动某个账号的挂机假人实例。
   * @param {string} name 实例名（= 配置中的 name）
   */
  /** 单独启动某个账号的挂机假人实例 */
  start(name) {
    let bot = this.bots.get(name);
    if (!bot) return { ok: false, message: `未找到实例: ${name}` };
    if (!bot._shutdown) return { ok: false, message: `实例[${name}] 已在运行` };
    // 停止过的实例需重建以清空旧闭包
    this.bots.delete(name);
    bot = new AfkBot(bot.cfg, {
      schedulerTickMs: this.schedulerTickMs,
      globalBotOptions: this.globalBotOptions,
      onEvent: (b, e, d) => this._onEvent(b, e, d)
    });
    this.bots.set(name, bot);
    bot.start();
    return { ok: true, message: `已启动实例: ${name}` };
  }

  /** 单独停止某个账号的挂机假人实例（可后续用 start 再次拉起） */
  stop(name) {
    const bot = this.bots.get(name);
    if (!bot) return { ok: false, message: `未找到实例: ${name}` };
    if (bot._shutdown) return { ok: false, message: `实例[${name}] 已停止` };
    bot.stop();
    return { ok: true, message: `已停止实例: ${name}（再次 start 即可拉起）` };
  }

  /** 单独重启某个账号的挂机假人实例 */
  restart(name) {
    const bot = this.bots.get(name);
    if (!bot) return { ok: false, message: `未找到实例: ${name}` };
    bot.stop();
    // 重新创建一个（避免旧连接的闭包遗留）
    const fresh = new AfkBot(bot.cfg, {
      schedulerTickMs: this.schedulerTickMs,
      globalBotOptions: this.globalBotOptions,
      onEvent: (b, e, d) => this._onEvent(b, e, d)
    });
    this.bots.set(name, fresh);
    fresh.start();
    return { ok: true, message: `已重启挂机假人: ${name}` };
  }

  /** 给某个挂机假人直接发一条聊天/指令 */
  sendCommand(name, command) {
    const bot = this.bots.get(name);
    if (!bot) return { ok: false, message: `未找到服务器: ${name}` };
    if (!bot.online || !bot.bot) return { ok: false, message: `挂机假人[${name}] 不在线` };
    try {
      bot.bot.chat(String(command));
      return { ok: true, message: `已发送: ${command}` };
    } catch (e) {
      return { ok: false, message: `发送失败: ${e.message}` };
    }
  }
}

module.exports = { BotsManager };
