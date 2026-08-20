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

  /** 拉取某实例最近的日志（供面板） */
  getLogs(name, limit) {
    const bot = this.bots.get(name);
    return bot ? bot.getLogs(limit) : [];
  }

  /** 面板触发某实例寻路移动到坐标 */
  goTo(name, x, y, z, range) {
    const bot = this.bots.get(name);
    if (!bot) return { ok: false, message: `未找到实例: ${name}` };
    return bot.goTo(Number(x), Number(y), Number(z), Number(range) || 1);
  }
  /** 停止某实例寻路 */
  stopPath(name) {
    const bot = this.bots.get(name);
    if (!bot) return { ok: false, message: `未找到实例: ${name}` };
    return bot.stopPath();
  }

  /** 依据配置重建单个实例（用于保存配置后的热重载 / 创建 / 删除） */
  _spawn(scfg) {
    if (this.bots.has(scfg.name)) {
      const old = this.bots.get(scfg.name);
      try { old.stop(); } catch (e) { /* ignore */ }
      this.bots.delete(scfg.name);
    }
    const bot = new AfkBot(scfg, {
      schedulerTickMs: this.schedulerTickMs,
      globalBotOptions: this.globalBotOptions,
      onEvent: (b, e, d) => this._onEvent(b, e, d)
    });
    this.bots.set(scfg.name, bot);
    return bot;
  }

  /** 新建实例：spawn 并启动（scfg 为完整配置对象） */
  addServer(scfg) {
    if (!scfg || !scfg.name) return { ok: false, message: '缺少实例 name' };
    if (this.bots.has(scfg.name)) return { ok: false, message: `实例已存在: ${scfg.name}` };
    const bot = this._spawn(scfg);
    bot.start();
    this.log.info(`已添加实例: ${scfg.name}`);
    return { ok: true, message: `已创建并启动实例: ${scfg.name}` };
  }

  /**
   * 更新单实例配置并热重载（scfg 为最新完整配置；支持改名：name 为旧名）
   */
  updateServer(name, scfg) {
    const renamed = scfg.name !== name;
    // 改名时，让 _spawn 按旧名清理旧实例（它内部按 scfg.name 判断，需先删旧 key）
    if (renamed && this.bots.has(name)) {
      try { this.bots.get(name).stop(); } catch (e) { /* ignore */ }
      this.bots.delete(name);
    }
    const exists = this.bots.has(name) || renamed;
    const bot = this._spawn(scfg);
    this.log.info(renamed ? `实例已改名 ${name} → ${scfg.name} 并热重载` : `已热重载实例配置: ${name}`);
    if (scfg.enabled !== false) {
      bot.start();
    }
    return { ok: true, message: `实例[${renamed ? name + '→' + scfg.name : name}] 配置已应用${exists ? '（已重启生效）' : ''}` };
  }

  /** 删除实例（停止并移除）；scfg 可带 enabled 判断 */
  removeServer(name) {
    const bot = this.bots.get(name);
    if (bot) { try { bot.stop(); } catch (e) { /* ignore */ } this.bots.delete(name); }
    this.log.info(`已删除实例: ${name}`);
    return { ok: true, message: `已删除实例: ${name}` };
  }

  /** 获取全部实例的完整配置（供配置编辑页面）——不暴露敏感字段 */
  getConfigs() {
    return [...this.bots.values()].map((b) => ({
      name: b.cfg.name, host: b.cfg.host, port: b.cfg.port, username: b.cfg.username,
      auth: b.cfg.auth, version: b.cfg.version || null, enabled: b.cfg.enabled !== false,
      acceptTpa: b.cfg.acceptTpa !== false, tpa: b.cfg.tpa || {},
      scheduledCommands: b.cfg.scheduledCommands || [], scheduledActions: b.cfg.scheduledActions || [],
      botOptions: b.cfg.botOptions || {}
    }));
  }
}

module.exports = { BotsManager };
