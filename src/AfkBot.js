'use strict';

const path = require('path');
const fs = require('fs');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const vec3 = require('vec3');
const logger = require('./logger');
const { resolveRequestRules, matchRequest, classifyResult } = require('./regexes');
const { Scheduler } = require('./scheduler');
const { normalizeMinecraftVersion } = require('./util/version');

// 重连参数（无限自动重连 + 指数退避 5s→最大30s，避免服务器波动期高频轰击）
const RECONNECT_DELAY_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_BACKOFF = 1.5;

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
    this._logSeq = 0;    // 单调递增序号，用于增量拉取与 gap 检测
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
    // 自动重连退避
    this._reconnectBackoffStep = 0;
    this._reconnectDelay = 0;
    // 微软登录钩子状态
    this._disposed = false;
    this._msaCodeLogged = false;
    this._msaRestore = null;
    this._msaTimer = null;
  }

  /** 统一的日志追加：带自增 seq（供增量拉取/gap 检测），环形上限 200 */
  _appendLog(entry) {
    const e = { seq: this._logSeq++, ...entry };
    this.logBuffer.push(e);
    if (this.logBuffer.length > 200) this.logBuffer.shift();
    return e;
  }

  /** 包装全局 logger：同时向本实例 logBuffer 记录，供面板读取 */
  _makeLogger(name) {
    const raw = logger.scope(name);
    const self = this;
    const buf = (level, args) => {
      try {
        const msg = args.map((a) => (a instanceof Error ? (a.stack || a.message) : String(a))).join(' ');
        self._appendLog({ ts: Date.now(), level, bot: name, msg });
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
  /**
   * 拉取日志。若 afterSeq>=0，只返回 seq>afterSeq 的新日志，并报告是否有 gap（缓冲滚动丢段）。
   * 返回 { logs, lastSeq, gap }
   */
  getLogs(limit, afterSeq) {
    const n = Math.max(1, Math.min(limit || 200, 200));
    if (afterSeq == null) {
      const logs = this.logBuffer.slice(-n);
      const lastSeq = logs.length ? logs[logs.length - 1].seq : -1;
      return { logs, lastSeq, gap: false };
    }
    const newer = this.logBuffer.filter((e) => e.seq > afterSeq);
    // 若缓冲最旧一条的 seq 也已经 > afterSeq，说明 afterSeq 段被环形滚动丢弃 → gap
    const gap = this.logBuffer.length > 0 && this.logBuffer[0].seq > afterSeq;
    const lastSeq = newer.length ? newer[newer.length - 1].seq : afterSeq;
    return { logs: newer.slice(-n), lastSeq, gap };
  }

  start() {
    this.createBot();
    this.setupScheduler();
  }

  stop() {
    this._shutdown = true;
    this._disposed = true;
    // 立即还原 console/stdout 钩子（避免 stop 后仍拦截/引用）
    try { if (this._msaRestore) this._msaRestore(); } catch (e) { /* ignore */ }
    this.scheduler.stop();
    if (this.bot) {
      try { this.bot.end('shutdown'); } catch (e) { /* ignore */ }
      this.bot = null;
    }
  }

  /**
   * 微软账号：捕获 prismarine-auth 设备码登录输出（链接 + code）转发到面板日志。
   * 拦截 console.*（prismarine-auth 用 console.info/log 打印）以及 process.stdout.write
   * （部分库直接写 stdout），确保 code 不遗漏。仅 auth=microsoft 时启用，2.5 分钟后自动还原。
   */
  _hookMsa() {
    if (this.cfg.auth !== 'microsoft') return;
    const self = this;
    const DEVICE_RE = /microsoft\.com\/link|aka\.ms\/devicelogin|enter the code|open the page|sign in|please authenticate|user_code|otc=|device code|设备码|登录代码|验证码/i;
    const sniff = (s) => {
      if (!s || !DEVICE_RE.test(s)) return;
      try {
        const uri = (s.match(/open the page\s+(\S+)/i) || s.match(/https?:\/\/\S+\/link[^ ]*/i) || s.match(/aka\.ms\/devicelogin[^ ]*/i) || [''])[1] || (s.match(/https?:\/\/\S+\/link[^ ]*/i) || [''])[0] || (s.match(/aka\.ms\/devicelogin[^ ]*/i) || [''])[0] || '';
        const code = (s.match(/the code\s+([A-Z0-9]{4,})/i) || s.match(/otc=([A-Z0-9]{4,})/i) || [])[1] || '';
        if (code && !self._msaCodeLogged) {
          self._msaCodeLogged = true;
          self._appendLog({ ts: Date.now(), level: 'warn', bot: self.cfg.name, msg: `【⚠️ 微软登录】请在浏览器打开 ${uri || 'https://www.microsoft.com/link'}，输入登录代码：${code}` });
        } else if (!self._msaCodeLogged) {
          self._appendLog({ ts: Date.now(), level: 'info', bot: self.cfg.name, msg: `【微软登录】${s}` });
        }
      } catch (e) { /* ignore */ }
    };
    // 保存原始引用，2.5 分钟后还原
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origConsole = {};
    const methods = ['log', 'info', 'warn', 'error'];
    for (const m of methods) origConsole[m] = console[m] ? console[m].bind(console) : (() => {});
    const restored = { flag: false };
    const restore = () => {
      if (restored.flag) return; restored.flag = true;
      for (const m of methods) console[m] = origConsole[m];
      process.stdout.write = origStdoutWrite;
      if (this._msaTimer) clearTimeout(this._msaTimer);
    };
    for (const m of methods) {
      console[m] = function (...a) { const s = a.map((x) => String(x)).join(' '); if (!self._disposed) sniff(s); return origConsole[m].apply(console, a); };
    }
    // 兜底：直接写 stdout 的 code 输出（注意不得在 sniff 里调用 console/stdout 以免递归）
    process.stdout.write = function (chunk, enc, cb) {
      try { if (!self._disposed) sniff(typeof chunk === 'string' ? chunk : chunk.toString('utf8')); } catch (e) { /* ignore */ }
      return origStdoutWrite(chunk, enc, cb);
    };
    this._msaRestore = restore;
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
      this._reconnectBackoffStep = 0;
      this._reconnectDelay = 0;
      this._onlineSince = Date.now();
      // 健康：记录本次会话上线时间，累计上次会话时长
      this.health.sessionOnlineMs = 0;
      this.health.lastOnlineAt = Date.now();
      const p = bot.entity && bot.entity.position;
      this.log.info(`已上线${p ? `，坐标 (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})` : ''}`);
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
    this.reconnectAttempts += 1;
    // 指数退避：5s、7.5s、11.25s ... 封顶 30s，持续自动重连（无限）
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_DELAY_MS * Math.pow(RECONNECT_BACKOFF, this._reconnectBackoffStep++)
    );
    this._reconnectDelay = delay;
    const attempt = this.reconnectAttempts;
    const sec = Math.round(delay / 1000);
    this.log.info(`第 ${attempt} 次重连（${sec}s 后尝试，退避中...）`);
    setTimeout(() => {
      if (this._shutdown) return;
      if (this._reconnectDelay !== delay) return; // 退避已更新，忽略过期定时器
      this.log.info(`开始第 ${attempt} 次重连`);
      this.createBot();
    }, delay);
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
      if (typeof type !== 'string' || !['swing', 'jump', 'walk', 'sneak', 'turn', 'rightclick', 'leftclick'].includes(type)) continue;
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
      } else if (type === 'rightclick') {
        // 右键：mode=use 使用手中物品/工具(锄头/SK铲子等)；mode=place 放置方块
        const mode = (sa && sa.mode) || 'use';
        if (mode === 'place') {
          this._actionRightPlace(bot);
        } else {
          bot.activateItem();   // 使用手中物品(锄头耕地/工具触发等)
          bot.swingArm();
          this.log.debug('执行动作: rightclick(使用手中物品/工具)');
        }
      } else if (type === 'leftclick') {
        // 左键：mode=dig 挖掘面前方块；mode=attack 攻击最近敌对生物
        const mode = (sa && sa.mode) || 'dig';
        if (mode === 'attack') {
          this._actionLeftAttack(bot);
        } else {
          this._actionLeftDig(bot);
        }
      }
      this.emit('action', { type });
    } catch (e) {
      this.log.error(`执行动作 ${type} 出错: ${e.message}`);
    }
  }

  /** 返回实体面朝方向的前方向量（缩放 dist 格） */
  _facingVec(bot, dist = 2) {
    const e = bot.entity;
    if (!e) return null;
    const yaw = e.yaw, pitch = e.pitch || 0;
    const dir = vec3(
      -Math.sin(yaw) * Math.cos(pitch),
      -Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch)
    );
    return dir.scaled(dist);
  }

  /** 返回面朝方向的单位主 face 向量（用于 placeBlock 参考面 / 定位前方参考块） */
  _facingFace(bot) {
    const e = bot.entity;
    if (!e) return vec3(0, 0, 1);
    const yaw = e.yaw, pitch = e.pitch || 0;
    const h = -Math.sin(yaw);           // x 分量
    const v = -Math.sin(pitch);         // y 分量
    const f = -Math.cos(yaw);           // z 分量
    // 选择主导方向做单位 face（优先水平；俯仰明显则垂直）
    if (Math.abs(v) > 0.5) return new vec3(0, v > 0 ? 1 : -1, 0);
    if (Math.abs(h) >= Math.abs(f)) return new vec3(h > 0 ? 1 : -1, 0, 0);
    return new vec3(0, 0, f > 0 ? 1 : -1);
  }

  /** 右键放置方块：对准星前方参考块，用手中方块放置（placeBlock）。无准星块则回退到前方 2 格块。 */
  _actionRightPlace(bot) {
    try {
      let ref = bot.blockAtCursor(4.5);
      if (!ref || !ref.boundingBox) {
        const fv = this._facingVec(bot, 2);
        const cand = bot.entity.position.plus(fv).floored();
        ref = bot.blockAt(cand);
      }
      if (!ref || !ref.boundingBox || ref.name === 'air') {
        this.log.warn('右键放置：前方无可作参考的方块');
        return;
      }
      const face = this._facingFace(bot);
      const shoulder = bot.entity.position.plus(vec3(0, bot.entity.height * 0.6, 0));
      bot.lookAt(shoulder, true, () => {
        bot.placeBlock(ref, face, (err) => {
          if (err) this.log.debug(`右键放置结果: ${err.message || '失败(无方块/位置已占)'}`);
          else this.log.info('右键放置方块成功');
        });
      });
    } catch (e) {
      this.log.error(`右键放置出错: ${e.message}`);
    }
  }

  /** 左键挖掘：挖掘准星指向前方最近的可挖方块 */
  _actionLeftDig(bot) {
    try {
      const target = bot.blockAtCursor(4.5);
      if (!target || target.name === 'air' || !target.boundingBox || target.boundingBox === 'empty') {
        this.log.debug('左键挖掘：准星前方没有可挖掘方块');
        return;
      }
      bot.dig(target, true, (err) => {
        if (err) this.log.debug(`挖掘结果: ${err.message || '失败'}`);
        else this.log.info('左键挖掘完成');
      });
    } catch (e) {
      this.log.error(`左键挖掘出错: ${e.message}`);
    }
  }

  /** 左键攻击：扫描实体，攻击最近的敌对生物(僵尸/骷髅等)。避开玩家与假人自身。 */
  _actionLeftAttack(bot) {
    try {
      const maxRange = 8;
      const hostiles = Object.values(bot.entities).filter((e) =>
        e && e.position && e.id !== bot.entity.id &&
        e.type !== 'player' &&
        (e.kind === 'Hostile mobs' || (e.mobType && !/villager|player/i.test(e.mobType)))
      );
      if (!hostiles.length) { this.log.debug('左键攻击：附近没有可攻击的敌对生物'); return; }
      let nearest = null, nd = Infinity;
      for (const e of hostiles) {
        const d = e.position.distanceTo(bot.entity.position);
        if (d < nd && d <= maxRange) { nd = d; nearest = e; }
      }
      if (!nearest) { this.log.debug(`左键攻击：敌对生物都在 ${maxRange} 格之外`); return; }
      bot.attack(nearest, true);
      this.log.info(`左键攻击 ${nearest.name || nearest.mobType || nearest.type}（距离 ${nd.toFixed(1)} 格）`);
    } catch (e) {
      this.log.error(`左键攻击出错: ${e.message}`);
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

  /** 返回物品图标相对路径(MCID public/img)，按 name.png → name_i.png → name_i.gif 三级回退；无则 null */
  _itemIcon(name) {
    if (!name) return null;
    const base = name.replace(/^minecraft:/, '');
    const dir = path.join(__dirname, '..', 'public', 'img');
    const tryList = [`${base}.png`, `${base}_i.png`, `${base}_i.gif`];
    for (const f of tryList) {
      if (fs.existsSync(path.join(dir, f))) return `/img/${f}`;
    }
    return null;
  }

  /**
   * 背包查看：读取假人背包(36格+快捷栏)与当前打开的窗口(容器)，供面板展示。
   * 返回 { ok, windowName, slots } slots: [{ slot, name, displayName, count, id, raw }]
   */
  getInventoryView() {
    if (!this.online || !this.bot) return { ok: false, message: '实例不在线' };
    try {
      const bot = this.bot;
      const window = bot.currentWindow || bot.inventory;
      const slots = (window.slots || []).map((item, i) => {
        const slotNum = window.inventorySlotToServer ? window.inventorySlotToServer(i) : i;
        if (!item) return { slot: slotNum, empty: true };
        const itemName = (item.name || item.type) ? String(item.name || item.type) : '';
        let displayName = itemName;
        try {
          const md = require('minecraft-data')(bot.version || '1.21.11');
          if (md.items && item.type != null && md.items[item.type]) displayName = md.items[item.type].displayName || itemName;
        } catch (e) { /* ignore */ }
        return { slot: slotNum, empty: false, name: itemName, displayName, icon: this._itemIcon(itemName), count: item.count, id: item.type, enchanted: !!(item.enchants && item.enchants.length) };
      });
      return { ok: true, windowName: window.title ? window.title.toString() : (window === bot.inventory ? '背包' : '窗口'), slots };
    } catch (e) {
      return { ok: false, message: `读取背包失败: ${e.message}` };
    }
  }

  /**
   * 背包操作：
   *   equipSlot { slot }         —— 把该格的物品装备到主手(从快捷栏/背包拿)
   *   setBar   { index }         —— 直接切换快捷栏第 index 格为主手
   *   move     { source, dest }  —— 把 source 格物品移到 dest 格(背包/容器)
   *   drop     { slot, count }   —— 丢出该格 count 个物品(默认1, 0=全部)
   */
  doInventoryAction(action, p) {
    if (!this.online || !this.bot) return { ok: false, message: '实例不在线' };
    const bot = this.bot;
    try {
      if (action === 'setBar') {
        const idx = Number(p.index);
        if (![0,1,2,3,4,5,6,7,8].includes(idx)) return { ok: false, message: '快捷栏索引需 0-8' };
        bot.setQuickBarSlot(idx);
        return { ok: true, message: `已切到快捷栏第 ${idx + 1} 格为主手` };
      }
      if (action === 'equipSlot') {
        const slot = Number(p.slot);
        if (!Number.isFinite(slot)) return { ok: false, message: '缺少 slot' };
        const window = bot.currentWindow || bot.inventory;
        const item = window.slots && window.slots[slot];
        if (!item) return { ok: false, message: '该格没有物品' };
        // mineflayer equip 需要 Item 对象；用 slot 装备到 hand
        bot.equip(item, 'hand', (err) => {
          if (err) this.log.warn(`装备 ${item.name} 到主手失败: ${err.message}`);
          else this.log.info(`已把 ${item.name} 拿到主手`);
        });
        return { ok: true, message: `正在把 ${item.name || '物品'} 装备到主手` };
      }
      if (action === 'move') {
        const s = Number(p.source), d = Number(p.dest);
        if (!Number.isFinite(s) || !Number.isFinite(d)) return { ok: false, message: '需要 source 和 dest' };
        bot.moveSlotItem(s, d);
        return { ok: true, message: `已移动 #${s} → #${d}` };
      }
      if (action === 'drop') {
        const slot = Number(p.slot);
        const count = Number(p.count) || 1;
        if (!Number.isFinite(slot)) return { ok: false, message: '缺少 slot' };
        // 丢出物品：取物品再丢到地面
        const window = bot.currentWindow || bot.inventory;
        const item = window.slots && window.slots[slot];
        if (!item) return { ok: false, message: '该格没有物品' };
        bot.toss(item, count, (err) => {
          if (err) this.log.warn(`丢弃物品失败: ${err.message}`);
          else this.log.info(`已丢出 ${count} 个 ${item.name}`);
        });
        return { ok: true, message: `正在丢出 ${count} 个 ${item.name || '物品'}` };
      }
      return { ok: false, message: `未知操作: ${action}` };
    } catch (e) {
      return { ok: false, message: `操作失败: ${e.message}` };
    }
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

module.exports = { AfkBot, RECONNECT_DELAY_MS, RECONNECT_MAX_DELAY_MS };
