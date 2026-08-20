'use strict';

const mineflayer = require('mineflayer');
const logger = require('./logger');
const { resolveRequestRules, matchRequest, classifyResult } = require('./regexes');
const { Scheduler } = require('./scheduler');

// 重连参数
const RECONNECT_DELAY_MS = 5000;
const RECONNECT_MAX_ATTEMPTS = 20;

/**
 * 单个挂机假人实例。
 * 负责：
 *   - 用 mineflayer 连接服务器（低占用选项）；
 *   - 监听聊天，命中服务器对应的 tpa/tpahere 请求正则后自动接受/拒绝；
 *   - 定时指令与定时动作（防 AFK）。
 */
class AfkBot {
  /**
   * @param {object} scfg 已规范化的服务器配置
   * @param {object} [options]
   * @param {number} [options.schedulerTickMs=1000]
   * @param {object} [options.globalBotOptions] 全局 mineflayer 选项兜底
   * @param {(bot:AfkBot, event:string, data:object)=>void} [options.onEvent]
   */
  constructor(scfg, options = {}) {
    this.cfg = scfg;
    this.options = options;
    this.logBuffer = []; // 每实例日志环形缓冲（供面板展示，最多 200 条）
    this.log = this._makeLogger(scfg.name || scfg.username || 'bot');

    this.bot = null;
    this.online = false;
    this.reconnectAttempts = 0;
    this._shutdown = false;
    this.tpaRules = resolveRequestRules(scfg, logger);
    this.scheduler = new Scheduler({ tickMs: options.schedulerTickMs || 1000 });
  }

  /** 包装全局 logger：同时向本实例 logBuffer 记录，供面板读取 */
  _makeLogger(name) {
    const raw = logger.scope(name);
    const self = this;
    const buf = (level, args) => {
      try {
        const msg = args.map((a) => (a instanceof Error ? (a.stack || a.message) : String(a))).join(' ');
        self.logBuffer.push({ ts: Date.now(), level, bot: name, msg });
        if (self.logBuffer.length > 200) self.logBuffer.shift();
      } catch (e) { /* ignore */ }
    };
    return {
      debug: (...a) => { buf('debug', a); raw.debug(...a); },
      info: (...a) => { buf('info', a); raw.info(...a); },
      warn: (...a) => { buf('warn', a); raw.warn(...a); },
      error: (...a) => { buf('error', a); raw.error(...a); }
    };
  }

  /** 供面板/API 拉取本实例最近的日志 */
  getLogs(limit) {
    const n = Math.max(1, Math.min(limit || 100, 200));
    return this.logBuffer.slice(-n);
  }

  start() {
    this.createBot();
    this.setupScheduler();
  }

  stop() {
    this._shutdown = true;
    this.scheduler.stop();
    if (this.bot) {
      try { this.bot.end('shutdown'); } catch (e) { /* ignore */ }
      this.bot = null;
    }
  }

  createBot() {
    const cfg = this.cfg;
    const mergedOptions = {
      host: cfg.host,
      port: cfg.port || 25565,
      username: cfg.username,
      auth: cfg.auth || 'offline',
      version: cfg.version || undefined,
      // 低占用：抑制 minecraft-protocol 偶发 chunk 解压错误的大量 hex 输出（可被覆盖）
      hideErrors: true,
      ...(this.options.globalBotOptions || {}),
      ...(cfg.botOptions || {})
    };

    this.log.info(`正在连接 ${cfg.host}:${cfg.port} (${cfg.username}) version=${cfg.version || 'auto'}`);
    let bot;
    try {
      bot = mineflayer.createBot(mergedOptions);
    } catch (err) {
      this.log.error('创建 bot 失败:', err && err.message);
      this.scheduleReconnect();
      return;
    }
    this.bot = bot;

    this.attachHandlers(bot);

    bot.once('spawn', () => {
      this.online = true;
      this.reconnectAttempts = 0;
      this._onlineSince = Date.now();
      const p = bot.entity && bot.entity.position;
      this.log.info(`已上线${p ? `，坐标 (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})` : ''}`);
      this.emit('spawn');
    });

    bot.on('kicked', (reason) => {
      let text = reason;
      if (reason && typeof reason === 'object') text = reason.text || reason.reason || JSON.stringify(reason);
      this.log.warn(`被服务器踢出: ${text}`);
    });

    bot.on('error', (err) => {
      this.log.error(`连接错误: ${err && err.message ? err.message : err}`);
    });

    bot.on('end', (reason) => {
      this.online = false;
      this.emit('end', { reason });
      if (this._shutdown) return;
      this.log.warn(`连接断开 (${reason || 'unknown'})，${RECONNECT_DELAY_MS / 1000}s 后重连`);
      this.scheduleReconnect();
    });
  }

  attachHandlers(bot) {
    // 聊天监听 → 自动接取 tpa / tpahere
    bot.on('message', (jsonMsg, position) => {
      this.handleChat(jsonMsg);
    });
    // 兼容部分服务器用 'chat' 事件（JsonChatEvent）
    bot.on('chat', (username, message) => {
      this.handleChatMessage(message);
    });
  }

  /** 事件转发 */
  emit(event, data) {
    if (this.options.onEvent) {
      try { this.options.onEvent(this, event, data || {}); } catch (e) { /* ignore */ }
    }
  }

  /**
   * 处理聊天消息：匹配 tpa / tpahere 请求正则后自动接受或拒绝。
   */
  handleChat(msg) {
    if (!this.online) return;
    const hit = matchRequest(this.tpaRules, msg);
    if (!hit) return;
    const { rule, match } = hit;
    this.log.debug(`命中传送请求正则 "${match}" (${rule.type})`);

    // ignore 类型：不自动处理
    if (rule.type === 'ignore') {
      this.log.info(`忽略传送请求规则: ${match}`);
      return;
    }

    // accept: true -> 发接受命令；false -> 发拒绝命令
    const decision = rule.accept !== false;
    const cmd = decision ? rule.requestCommand : rule.denyCommand;
    const label = decision ? '接受' : '拒绝';
    this.log.info(`检测到 ${rule.type === 'tpahere' ? 'tpahere' : 'tpa'} 请求，自动${label} → ${cmd}`);

    // 发送前冷却，避免瞬间重复触发刷屏（同一规则 3s 内只发一次）
    const now = Date.now();
    const key = `${rule.type}:${cmd}`;
    if (this._lastTpaCmd && this._lastTpaCmd.key === key && now - this._lastTpaCmd.ts < 3000) {
      return;
    }
    this._lastTpaCmd = { key, ts: now };

    try {
      this.bot.chat(cmd);
      this.emit('tpa', { type: rule.type, action: decision ? 'accept' : 'deny', command: cmd });
    } catch (e) {
      this.log.error(`发送 ${cmd} 失败: ${e && e.message}`);
    }
  }

  handleChatMessage(message) {
    if (!this.online || !message) return;
    const plain = require('./regexes').toPlain(message);
    // 结果反馈（可选日志）
    const cls = classifyResult(plain);
    if (cls) {
      this.log.debug(`传送结果: ${cls}`);
      this.emit('tpaResult', { result: cls, text: plain });
    }
  }

  scheduleReconnect() {
    if (this._shutdown) return;
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.log.error(`连续 ${RECONNECT_MAX_ATTEMPTS} 次重连失败，停止自动重连`);
      return;
    }
    this.reconnectAttempts += 1;
    setTimeout(() => {
      if (this._shutdown) return;
      this.log.info(`第 ${this.reconnectAttempts} 次重连...`);
      this.createBot();
    }, RECONNECT_DELAY_MS);
  }

  /** 设置定时指令与定时动作 */
  setupScheduler() {
    const cfg = this.cfg;

    // 定时指令
    for (const sc of (cfg.scheduledCommands || [])) {
      const command = sc.command;
      if (typeof command !== 'string' || !command) continue;
      try {
        this.scheduler.add({
          name: `cmd:${command}`,
          every: sc.every,
          cron: sc.cron,
          onFire: () => {
            if (!this.online || !this.bot) return;
            this.log.info(`定时指令 → ${command}`);
            try { this.bot.chat(command); } catch (e) { this.log.error(`执行定时指令 ${command} 失败: ${e.message}`); }
          }
        });
      } catch (e) {
        this.log.warn(`跳过定时指令 ${command}: ${e.message}`);
      }
    }

    // 定时动作
    for (const sa of (cfg.scheduledActions || [])) {
      const type = sa.type;
      if (typeof type !== 'string' || !['swing', 'jump', 'walk', 'sneak', 'turn'].includes(type)) continue;
      try {
        this.scheduler.add({
          name: `action:${type}`,
          every: sa.every || 600000,
          onFire: () => {
            if (!this.online || !this.bot) return;
            this.doAction(type, sa);
          }
        });
      } catch (e) {
        this.log.warn(`跳过定时动作 ${type}: ${e.message}`);
      }
    }

    this.scheduler.start();
  }

  /**
   * 执行一个动作（防 AFK + 心跳）。
   * swing  : 挥臂；jump : 原地跳；walk : 前/后走一段；sneak : 潜行一下；turn : 转身
   */
  doAction(type, sa) {
    const bot = this.bot;
    try {
      if (type === 'swing') {
        bot.swingArm();
        this.log.debug('执行动作: swing(挥臂)');
      } else if (type === 'walk') {
        // 短暂走动（默认前进，direction:"back" 后退），之后复位
        const back = sa && sa.direction === 'back';
        bot.setControlState('forward', !back);
        bot.setControlState('back', !!back);
        const holdMs = Math.max((sa && sa.holdMs) || 600, 200);
        setTimeout(() => {
          if (!this.bot || this.bot !== bot) return;
          try {
            bot.setControlState('forward', false);
            bot.setControlState('back', false);
          } catch (e) { /* ignore */ }
        }, holdMs);
        this.log.debug(`执行动作: walk(${back ? '后退' : '前进'})`);
      } else if (type === 'jump') {
        // 原地跳一下（不额外前进），复位
        bot.setControlState('jump', true);
        setTimeout(() => {
          if (!this.bot || this.bot !== bot) return;
          try { bot.setControlState('jump', false); } catch (e) { /* ignore */ }
        }, 400);
        this.log.debug('执行动作: jump(跳跃)');
      } else if (type === 'sneak') {
        bot.setControlState('sneak', true);
        setTimeout(() => {
          if (!this.bot || this.bot !== bot) return;
          try { bot.setControlState('sneak', false); } catch (e) { /* ignore */ }
        }, 800);
        this.log.debug('执行动作: sneak(潜行)');
      } else if (type === 'turn') {
        if (bot.entity && bot.entity.yaw !== undefined) {
          bot.look(bot.entity.yaw + Math.PI, 0, true);
          this.log.debug('执行动作: turn(转身)');
        }
      }
      this.emit('action', { type });
    } catch (e) {
      this.log.error(`执行动作 ${type} 出错: ${e.message}`);
    }
  }

  getStatus() {
    return {
      name: this.cfg.name,
      username: this.cfg.username,
      host: this.cfg.host,
      port: this.cfg.port,
      online: this.online,
      reconnectAttempts: this.reconnectAttempts,
      tpaRules: this.tpaRules.length,
      scheduledCommands: (this.cfg.scheduledCommands || []).length,
      scheduledActions: (this.cfg.scheduledActions || []).length,
      uptime: this.online && this.bot ? Math.round((Date.now() - this._onlineSince) / 1000) : 0
    };
  }
}

module.exports = { AfkBot, RECONNECT_DELAY_MS, RECONNECT_MAX_ATTEMPTS };
