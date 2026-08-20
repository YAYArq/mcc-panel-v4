'use strict';

// 面板配置存储：读写 config.json（及可叠加的 config.local.json），管理 servers 数组的 CRUD。
// 写盘采用原子写（临时文件 + rename），避免进程崩溃破坏配置。
// 保存后由上层(BotsManager)热重载对应实例。

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const JSONC = (o) => JSON.stringify(o, null, 2) + '\n';

class ConfigStore {
  /**
   * @param {object} opts { configPath?, dataPath? }
   * dataPath: 写入目标（默认 = configPath；若存在 config.local.json 则写入其中，避免污染模板）
   */
  constructor(opts = {}) {
    this.configPath = opts.configPath || path.join(__dirname, '..', 'config.json');
    let local = path.join(path.dirname(this.configPath), 'config.local.json');
    if (fs.existsSync(local)) {
      this.dataPath = local;
    } else if (opts.dataPath) {
      this.dataPath = opts.dataPath;
    } else {
      this.dataPath = this.configPath;
    }
    this.log = logger.scope('store');
  }

  _read() {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      this.log.error('读取 config.json 失败:', e.message);
      return { servers: [] };
    }
  }

  /** 原子写盘（写临时文件后 rename） */
  _write(json) {
    const tmp = this.dataPath + '.tmp';
    fs.writeFileSync(tmp, JSONC(json));
    fs.renameSync(tmp, this.dataPath);
    this.log.info('已写盘: ' + this.dataPath);
  }

  /** 返回 servers 数组（对象元素；字符串注释行原样保留，但视为注释不影响功能） */
  getServers() {
    const json = this._read();
    return Array.isArray(json.servers) ? json.servers : [];
  }

  getServer(name) {
    return this.getServers().find((s) => s && typeof s === 'object' && s.name === name) || null;
  }

  /**
   * 新建实例。返回 { ok, message, index }。
   * @param {object} scfg 连接参数 + 可选 tpa/定时任务
   */
  createServer(scfg) {
    if (!scfg || typeof scfg !== 'object') return { ok: false, message: '配置必须是对象' };
    if (typeof scfg.name !== 'string' || !scfg.name.trim()) return { ok: false, message: 'name 必填' };
    if (!scfg.host || !scfg.username) return { ok: false, message: 'host 与 username 必填' };
    const json = this._read();
    const servers = Array.isArray(json.servers) ? json.servers : [];
    if (servers.some((s) => s && typeof s === 'object' && s.name === scfg.name)) {
      return { ok: false, message: `实例名已存在: ${scfg.name}` };
    }
    const entry = {
      name: scfg.name,
      host: scfg.host,
      port: Number(scfg.port) || 25565,
      username: scfg.username,
      auth: scfg.auth || 'offline',
      version: scfg.version || undefined,
      acceptTpa: scfg.acceptTpa !== false,
      tpa: scfg.tpa || {},
      scheduledCommands: Array.isArray(scfg.scheduledCommands) ? scfg.scheduledCommands : [],
      scheduledActions: Array.isArray(scfg.scheduledActions) ? scfg.scheduledActions : [],
      botOptions: scfg.botOptions || {}
    };
    // 去掉 auth 为 offline 时多余的 password
    delete entry.password;
    servers.push(entry);
    json.servers = servers;
    this._write(json);
    return { ok: true, message: `已创建实例: ${scfg.name}`, server: entry };
  }

  /**
   * 更新实例配置（合并 patch）。
   * @param {string} name
   * @param {object} patch 要更新的字段（整段替换字段）
   */
  updateServer(name, patch) {
    if (!patch || typeof patch !== 'object') return { ok: false, message: '配置必须是对象' };
    const json = this._read();
    const servers = Array.isArray(json.servers) ? json.servers : [];
    // 只更新对象元素
    let target = servers.find((s) => s && typeof s === 'object' && s.name === name);
    if (!target) return { ok: false, message: `实例不存在: ${name}` };

    // 允许更新的字段白名单
    const keys = ['host', 'port', 'username', 'auth', 'version', 'acceptTpa', 'tpa', 'scheduledCommands', 'scheduledActions', 'botOptions', 'enabled'];
    for (const k of keys) {
      if (patch[k] !== undefined) target[k] = patch[k];
    }
    if (target.port !== undefined) target.port = Number(target.port) || 25565;
    if (target.name !== undefined && target.name !== name) return { ok: false, message: 'name 不可修改' };
    // 规范化必填
    if (!target.host || !target.username) return { ok: false, message: 'host 与 username 不能为空' };

    json.servers = servers;
    this._write(json);
    return { ok: true, message: '配置已保存', server: target };
  }

  removeServer(name) {
    const json = this._read();
    const servers = Array.isArray(json.servers) ? json.servers : [];
    const idx = servers.findIndex((s) => s && typeof s === 'object' && s.name === name);
    if (idx < 0) return { ok: false, message: `实例不存在: ${name}` };
    servers.splice(idx, 1);
    json.servers = servers;
    this._write(json);
    return { ok: true, message: `已删除实例: ${name}` };
  }
}

module.exports = { ConfigStore };
