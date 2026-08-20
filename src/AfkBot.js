'use strict';

const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const inventoryViewer = require('mineflayer-web-inventory');
const logger = require('./logger');
const { resolveRequestRules, matchRequest, classifyResult } = require('./regexes');
const { Scheduler } = require('./scheduler');
const { normalizeMinecraftVersion } = require('./util/version');

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
    // 健康监控统计
    this.health = {
      lastOnlineAt: null,   // 最近一次上线时间
      lastOfflineAt: null,  // 最近一次离线时间（含本次会话断开）
      sessionOnlineMs: 0,   // 本次会话在线时长(ms)
      totalOnlineMs: 0,     // 累计在线时长(ms)
      totalDisconnects: 0,  // 累计断线次数
      lastDisconnectReason: '',
      startedAt: Date.now() // 实例创建时间
    };
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

  /** 微软账号：捕获设备码登录链接/code 转发到面板日志（auth=microsoft 时调用） */
  /**
   * 微软账号：捕获 prismarine-auth 设备码登录输出（链接 + code）转发到面板日志。
   * 注意：prismarine-auth 用 console.info 打印「Please authenticate now」和 message，
   * 因此需要拦截 console.info（以及 log/warn/error），否则登录 code 不会出现在面板日志。
   */
  _hookMsa() {
    if (this.cfg.auth !== 'microsoft') return;
    const self = this;
    const methods = ['log', 'info', 'warn', 'error'];
    const orig = {};
    for (const m of methods) orig[m] = console[m] ? console[m].bind(console) : (() => {});
    const sniff = (s) => {
      if (!s) return;
      // prismarine-auth 设备码 message 形如：
      //   To sign in, use a web browser to open the page <uri> and use the code <CODE> or visit http://microsoft.com/link?otc=<CODE>
      if (/microsoft\.com\/link|aka\.ms\/devicelogin|enter the code|要登录|open the page|sign in|Please authenticate|user_code|otc=/.test(s)) {
        try {
          // 提取链接与 code，整理成清晰提示
          const uri = (s.match(/open the page\s+(\S+)/i) || s.match(/https?:\/\/\S+\/link[^ ]*/i) || [])[1] || (s.match(/aka\.ms\/devicelogin[^ ]*/i) || [])[0] || '';
          const code = (s.match(/the code\s+([A-Z0-9]+)/i) || s.match(/otc=([A-Z0-9]+)/i) || [])[1] || '';
          const base = '【微软登录】';
          if (uri && code) {
            self.logBuffer.push({ ts: Date.now(), level: 'info', bot: self.cfg.name, msg: `${base}请在浏览器打开 ${uri}，输入登录代码: ${code}` });
          } else {
            self.logBuffer.push({ ts: Date.now(), level: 'info', bot: self.cfg.name, msg: base + s });
          }
        } catch (e) { /* ignore */ }
      }
    };
    let restored = false;
    const restore = () => {
      if (restored) return; restored = true;
      for (const m of methods) console[m] = orig[m];
      if (this._msaTimer) clearTimeout(this._msaTimer);
    };
    // 包装各方法：转发到面板日志，同时保持原输出（systemd journal 也能看到）
    for (const m of methods) {
      console[m] = function (...a) { sniff(a.map((x) => String(x)).join(' ')); return orig[m].apply(console, a); };
    }
    if (this._msaTimer) clearTimeout(this._msaTimer);
    this._msaTimer = setTimeout(restore, 150000);
  }

  createBot() {
    const cfg = this.cfg;
    // 版本归一化：26.1.2/26.2 -> 26.1（mineflayer-x 协议 775），其余透传
    const normVersion = normalizeMinecraftVersion(cfg.version);
    if (cfg.version && normVersion !== cfg.version) {
      this.log.info(`版本 ${cfg.version} 归一化为 ${normVersion}（mineflayer-x 协议兼容）`);
    }
    const mergedOptions = {
      host: cfg.host,
      port: cfg.port || 25565,
      username: cfg.username,
      auth: cfg.auth || 'offline',
      version: normVersion || undefined,
      // 低占用：抑制 minecraft-protocol 偶发 chunk 解压错误的大量 hex 输出（可被覆盖）
      hideErrors: true,
      ...(this.options.globalBotOptions || {}),
      ...(cfg.botOptions || {})
    };

    if (cfg.auth === 'microsoft') this._hookMsa();
    this.log.info(`正在连接 ${cfg.host}:${cfg.port} (${cfg.username}) 登录方式=${cfg.auth || 'offline'} version=${cfg.version || 'auto'}`);
    if (cfg.auth === 'microsoft') {
      this.log.info('微软账号登录：请在面板日志查看设备码链接（https://www.microsoft.com/link），用浏览器打开并输入 Code 完成授权');
    }
    let bot;
    try {
      bot = mineflayer.createBot(mergedOptions);
    } catch (err) {
      this.log.error('创建 bot 失败:', err && err.message);
      this.scheduleReconnect();
      return;
    }
    this.bot = bot;

    // 接入 mineflayer-pathfinder（寻路 / 面板坐标移动）
    try {
      bot.loadPlugin(pathfinder);
      this.log.debug('已加载 mineflayer-pathfinder 插件');
    } catch (e) {
      this.log.error('加载 mineflayer-pathfinder 失败:', e && e.message);
    }

    this.attachHandlers(bot);

    bot.once('spawn', () => {
      this.online = true;
      this.reconnectAttempts = 0;
      this._onlineSince = Date.now();
      // 健康：记录本次会话上线时间，累计上次会话时长
      this.health.sessionOnlineMs = 0;
      this.health.lastOnlineAt = Date.now();
      const p = bot.entity && bot.entity.position;
      this.log.info(`已上线${p ? `，坐标 (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})` : ''}`);
      this.maybeStartWebInventory();
      this.emit('spawn');
    });

    bot.on('kicked', (reason) => {
      let text = reason;
      if (reason && typeof reason === 'object') text = reason.text || reason.reason || JSON.stringify(reason);
      this.health.lastDisconnectReason = text;
      this.log.warn(`被服务器踢出: ${text}`);
    });

    bot.on('error', (err) => {
      this.log.error(`连接错误: ${err && err.message ? err.message : err}`);
    });

    bot.on('end', (reason) => {
      this.online = false;
      // 健康：累计在线时长与断线次数
      const now = Date.now();
      if (this._onlineSince) {
        const dur = now - this._onlineSince;
        this.health.sessionOnlineMs = dur;
        this.health.totalOnlineMs += dur;
        this._onlineSince = null;
      }
      this.health.lastOfflineAt = now;
      if (this._shutdown) {
        this.health.lastDisconnectReason = 'shutdown';
      } else {
        this.health.totalDisconnects += 1;
        if (!this.health.lastDisconnectReason) this.health.lastDisconnectReason = String(reason || 'unknown');
      }
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
   * 若开启“白名单模式”(tpaWhiteListOnly)，仅接受白名单内玩家的请求；白名单外一律忽略（不自动接受也不拒绝）。
   */
  handleChat(msg) {
    if (!this.online) return;
    const hit = matchRequest(this.tpaRules, msg);
    if (!hit) return;
    const { rule, match, player } = hit;
    this.log.debug(`命中传送请求正则 "${match}" (${rule.type}${player ? `，请求者 ${player}` : ''})`);

    // ignore 类型：不自动处理
    if (rule.type === 'ignore') {
      this.log.info(`忽略传送请求规则: ${match}`);
      return;
    }

    // ---- TPA 白名单模式 ----
    const wlOnly = this.cfg.tpaWhiteListOnly === true;
    if (wlOnly) {
      const wl = Array.isArray(this.cfg.tpaWhiteListPlayers) ? this.cfg.tpaWhiteListPlayers.map((n) => String(n).trim().toLowerCase()) : [];
      // 无法识别请求者，或未配置白名单 → 一律不理会
      if (!player) {
        this.log.debug(`白名单模式下无法识别请求者，忽略: ${match}`);
        return;
      }
      if (wl.length === 0) {
        this.log.debug(`白名单模式下未配置白名单，忽略请求者 ${player}`);
        return;
      }
      if (!wl.includes(player.toLowerCase())) {
        this.log.info(`TPA 请求来自白名单外玩家 ${player}（不在白名单），已忽略`);
        return;
      }
      // 白名单内：一律自动接受
      const cmd = rule.requestCommand;
      this.log.info(`TPA 请求来自白名单内玩家 ${player}，自动接受 → ${cmd}`);
      this._sendTpaCmd(rule, cmd, player);
      return;
    }

    // ---- 普通模式（无白名单过滤，按规则接受/拒绝） ----
    const decision = rule.accept !== false;
    const cmd = decision ? rule.requestCommand : rule.denyCommand;
    const label = decision ? '接受' : '拒绝';
    this.log.info(`检测到 ${rule.type === 'tpahere' ? 'tpahere' : 'tpa'} 请求，自动${label} → ${cmd}`);
    this._sendTpaCmd(rule, cmd, player);
  }

  /** 发送接受/拒绝命令（带 3s 冷却） */
  _sendTpaCmd(rule, cmd, player) {
    if (!this.online || !this.bot) return;
    const now = Date.now();
    const key = `${rule.type}:${cmd}`;
    if (this._lastTpaCmd && this._lastTpaCmd.key === key && now - this._lastTpaCmd.ts < 3000) {
      return;
    }
    this._lastTpaCmd = { key, ts: now };
    try {
      this.bot.chat(cmd);
      this.emit('tpa', { type: rule.type, action: cmd === rule.requestCommand ? 'accept' : 'deny', command: cmd, player: player || null });
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

  /**
   * 网页背包：按配置端口启动 mineflayer-web-inventory（每实例只启动一次）。
   * 配置：webInventoryPort>0 才会启动；webInventoryDir 为静态资源目录。
   */
  maybeStartWebInventory() {
    const port = Number(this.cfg.webInventoryPort) || 0;
    if (port <= 0) return;
    if (this._webInvStarted) return;
    try {
      const dir = path.resolve(this.cfg.webInventoryDir || path.join(__dirname, '..', '.webinventory'), this.cfg.name);
      inventoryViewer(this.bot, { port, webPath: dir, startOnLoad: true });
      this._webInvStarted = true;
      this.webInventoryPort = port;
      this.log.info(`网页背包已启动 http://<服务器IP>:${port}`);
    } catch (e) {
      this.log.error(`网页背包启动失败: ${e && e.message}`);
    }
  }

  /**
   * 寻路移动到指定坐标（需要 mineflayer-pathfinder）。依赖 bot 在线。
   * @param {number} x @param {number} y @param {number} z
   * @param {number} [range] 到达容差（格）
   */
  goTo(x, y, z, range = 1) {
    if (!this.online || !this.bot || !this.bot.pathfinder) {
      return { ok: false, message: '实例不在线或未加载寻路插件' };
    }
    try {
      const bot = this.bot;
      const defaultMove = new Movements(bot);
      bot.pathfinder.setMovements(defaultMove);
      const goal = new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z), range);
      bot.pathfinder.setGoal(goal);
      this.log.info(`开始寻路移动到 (${x}, ${y}, ${z})`);
      return { ok: true, message: `已开始移动至 (${x}, ${y}, ${z})` };
    } catch (e) {
      return { ok: false, message: `寻路失败: ${e.message}` };
    }
  }

  /** 停止当前寻路 */
  stopPath() {
    if (this.bot && this.bot.pathfinder) {
      try { this.bot.pathfinder.setGoal(null); } catch (e) { /* ignore */ }
      return { ok: true, message: '已停止寻路' };
    }
    return { ok: false, message: '实例不在线或未加载寻路插件' };
  }

  getStatus() {
    const now = Date.now();
    const session = this.online && this._onlineSince ? now - this._onlineSince : 0;
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
      uptime: this.online ? Math.round(session / 1000) : 0,
      webInventoryPort: Number(this.cfg.webInventoryPort) || 0,
      // ---- 健康监控 ----
      health: {
        sessionOnlineMs: this.online ? session : this.health.sessionOnlineMs,
        totalOnlineMs: this.health.totalOnlineMs + (this.online ? session : 0),
        totalDisconnects: this.health.totalDisconnects,
        lastOnlineAt: this.health.lastOnlineAt,
        lastOfflineAt: this.health.lastOfflineAt,
        lastDisconnectReason: this.health.lastDisconnectReason,
        startedAt: this.health.startedAt
      }
    };
  }
}

module.exports = { AfkBot, RECONNECT_DELAY_MS, RECONNECT_MAX_ATTEMPTS };
