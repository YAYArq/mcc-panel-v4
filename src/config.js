'use strict';

// 配置加载与校验。
// 支持:
//   config.json                —— 主文件
//   config.local.json          —— 本地覆盖（可选，不提交到 git）
//   环境变量 CONFIG_PATH       —— 自定义路径

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const ROOT = path.join(__dirname, '..');

/** 兜底的缺省配置，保证即使 config.json 缺字段也能跑起来。 */
const DEFAULTS = {
  // 全局日志级别
  logLevel: 'info',

  // 连接到服务器时的通用 mineflayer 选项（未配置则默认）
  botOptions: {},

  // 是否启用 MCSManager 面板守护（重连/保活）
  mcsm: { enabled: false },

  // 服务器列表
  servers: []
};

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    logger.error('解析配置文件失败', file, '->', e.message);
    process.exit(1);
  }
}

function deepMerge(base, extra) {
  if (base && typeof base === 'object' && !Array.isArray(base)) {
    const out = { ...base };
    for (const k of Object.keys(extra || {})) {
      out[k] = deepMerge(base[k], extra[k]);
    }
    return out;
  }
  return extra === undefined ? base : extra;
}

function normalizeServer(s, idx) {
  // 允许数组里出现字符串作为示意注释行（如 "//说明...")，直接跳过
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const name = s.name || `server${idx + 1}`;
  const out = {
    name,
    host: s.host,
    port: s.port || 25565,
    username: s.username,
    // 可选项
    password: s.password || '',
    auth: s.auth || 'offline',
    version: s.version || undefined,
    // 是否启用
    enabled: s.enabled !== false,
    // 是否自动接取 tpa/tpahere，默认开启
    acceptTpa: s.acceptTpa !== false,
    // 是否自动拒绝 tpahere（有些服务器可配置），默认接受与拒绝都跟随 acceptTpa
    denyTpa: s.denyTpa === true,
    // 按服务器覆盖的聊天正则（详见 regexes.js 的内置规则）
    tpa: s.tpa || {},
    // TPA 白名单：true 时仅接受白名单内玩家的请求；白名单为空则一律不理会
    tpaWhiteListOnly: s.tpaWhiteListOnly === true,
    tpaWhiteListPlayers: Array.isArray(s.tpaWhiteListPlayers) ? s.tpaWhiteListPlayers : [],
    // 定时指令
    scheduledCommands: s.scheduledCommands || [],
    // 定时动作
    scheduledActions: s.scheduledActions || [],
    // mineflayer 额外选项
    botOptions: s.botOptions || {},
    // 网页背包(mineflayer-web-inventory)：port>0 时启动该端口；dir 为静态资源目录
    webInventoryPort: Number(s.webInventoryPort) || 0,
    webInventoryDir: s.webInventoryDir || undefined
  };

  if (!out.host) {
    logger.error(`服务器[${name}]缺少 host，已跳过。`);
    out.enabled = false;
  }
  if (!out.username) {
    logger.error(`服务器[${name}]缺少 username，已跳过。`);
    out.enabled = false;
  }
  return out;
}

function loadConfig({ path: cfgPath } = {}) {
  const mainPath = cfgPath || process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
  const localPath = path.join(path.dirname(mainPath), 'config.local.json');

  const main = loadJson(mainPath);
  if (!main) {
    logger.warn('未找到 config.json，将使用缺省配置（不会连接任何服务器）。');
  }
  const local = loadJson(localPath);

  let cfg = deepMerge(DEFAULTS, main || {});
  if (local) cfg = deepMerge(cfg, local);
  else if (main && main.inheritDefault === false) {
    cfg = deepMerge(DEFAULTS, cfg);
  }

  // 规范化（字符串注释行会被 normalizeServer 返回 null 并过滤掉）
  cfg.logger = logger.scope('cfg');
  cfg.servers = (cfg.servers || []).map(normalizeServer).filter(Boolean);

  return cfg;
}

module.exports = { loadConfig, DEFAULTS };
