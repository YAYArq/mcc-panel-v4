'use strict';

/**
 * 不同服务器 TPA 插件的消息正则库。
 *
 * 各服务器使用的 TPA 插件（EssentialsX / SimpleTpa / CMI / CMI/自定义插件）的聊天提示文案
 * 与触发命令都不相同。这里：
 *   1. 内置常见插件的默认规则（开箱即用）；
 *   2. 允许在 config.json 中按服务器覆盖（servers[].tpa），做到“识别不同服务器的正则表达式”。
 *
 * 两类规则：
 *  - REQUEST：有人向 bot 发起 tpa / tpahere 请求，命中后自动接受 / 拒绝。
 *  - RESULT ：执行接受后，服务器返回的“已接受 / 已拒绝 / 传送成功”等结果，用于日志与反馈。
 *
 * 每个 REQUEST pattern：
 *   regex           —— 匹配聊天消息的正则字符串（内部 new RegExp，忽略大小写）
 *   type            —— 'tpa' | 'tpahere' | 'ignore'
 *                      tpa     : 有人请求传送 bot 过去（bot 是接收者，需要接受）
 *                      tpahere : 有人请求传送过来找 bot（bot 是接收者，需要接受）
 *                      ignore  : 命中后不自动接受（按该条消息的 accept=false 处理）
 *   requestCommand  —— 接受请求所用的命令（插件相关，如 /tpaccept /tpayes /yes ...）
 *   denyCommand     —— 拒绝请求所用的命令
 *   accept          —— true（默认）自动接受；false 自动拒绝（发 denyCommand）
 */

// ---- 内置 REQUEST 规则：匹配“bot 收到传送请求”的常见文案 ----
const BUILTIN_REQUEST_RULES = [
  // 中文 Essentials / 常见汉化
  { regex: '请求传送(到你的位置|到你的身边|至你|到你所在的位置)', type: 'tpa' },
  { regex: '请求你.{0,6}(传送到|前往).{0,6}他的?(身边|所在位置|位置)', type: 'tpa' },
  { regex: '(向你|给你).{0,4}(发出|发送|发起了?).{0,2}(tpa|传送).{0,4}(请求|邀请)', type: 'tpa' },
  { regex: '(tpahere|传送请求).{0,4}(待处理|已到达|请(点击|使用))', type: 'tpahere' },
  // 英文
  { regex: 'has requested to teleport to you', type: 'tpa' },
  { regex: 'has requested that you teleport to them', type: 'tpa' },
  { regex: 'requests to teleport to you', type: 'tpa' },
  { regex: 'requests that you teleport to (them|their location)', type: 'tpa' },
  // 通用“点击接受”按钮提示
  { regex: '(\\[(点击接受|接受|accept)\\])', type: 'tpa' },
];

// ---- 内置 RESULT 规则：接受后判断是否真的传送成功（日志反馈用） ----
const BUILTIN_RESULT_RULES = {
  accept: [
    /传送(?:请求)?(?:已|被|获|已经|已被|已经由)*(接受|同意)|(接受|同意)(了)?(你(的)?)?(传送|tp|tpa)(请求)?/i,
    /(传送|瞬移)(成功|完成|已开始|开始|进行中)/i,
    /teleporting|teleported/i,
    /request accepted|accepts your|accepted your|teleport request accepted/i
  ],
  reject: [
    /拒绝|不同意|已取消|取消请求/,
    /不在线|未在线|离线|不存在|找不到(该)?(玩家|目标)/,
    /超时|已过期|已超时|expired|timed?\s*out/i,
    /denied|declined|rejected|refused|cancelled|canceled/i,
    /not online|offline|not found|no longer/i
  ]
};

/** 剥色码 */
function stripColor(text) {
  return String(text || '').replace(/[§\u00a7][0-9a-fk-or]/gi, '');
}

/** 从 ChatMessage 或字符串提取纯文本 */
function toPlain(raw) {
  if (raw && typeof raw === 'object') {
    try {
      if (typeof raw.toAnsi === 'function') return stripColor(raw.toAnsi());
      if (typeof raw.toString === 'function') return stripColor(raw.toString());
    } catch (e) { /* ignore */ }
  }
  return stripColor(String(raw == null ? '' : raw));
}

/**
 * 解析一服务器实际使用的 REQUEST 规则列表。
 * 服务器可通过 servers[].tpa.patternsOverride=true 彻底覆盖内置（否则内置在前，便于追加自定义）。
 */
function resolveRequestRules(server, logger) {
  const cfg = server.tpa || {};

  let patterns;
  const custom = Array.isArray(cfg.patterns) ? cfg.patterns : [];
  if (cfg.patternsOverride === true) {
    patterns = custom;
  } else {
    patterns = [...BUILTIN_REQUEST_RULES].concat(custom);
  }

  return patterns.map((p) => {
    if (typeof p === 'string') p = { regex: p };
    p = p || {};
    let re = null;
    try {
      re = new RegExp(p.regex, 'i');
    } catch (e) {
      if (logger) logger.warn(`服务器[${server.name}] 的 tpa 正则解析失败，已忽略: ${p.regex} (${e.message})`);
      re = null;
    }
    return {
      reg: re,
      type: p.type || 'tpa', // 'tpa'|'tpahere'|'ignore'
      accept: p.accept !== false,
      requestCommand: p.requestCommand || cfg.acceptCommand || '/tpaccept',
      denyCommand: p.denyCommand || cfg.denyCommand || '/tpdeny'
    };
  }).filter((r) => r.reg !== null);
}

/**
 * 匹配一条聊天消息是否命中“有人请求传送”的规则。
 * @returns {{rule:object, match:string, player:string|null}|null}
 *   player: 正则第一个捕获组（若有）——用于 TPA 白名单判断（请求者玩家名）
 */
function matchRequest(rules, text) {
  const plain = toPlain(text);
  if (!plain) return null;
  for (const rule of rules) {
    const m = rule.reg.exec(plain);
    if (m) {
      const player = m.length > 1 ? (m[1] || null) : null;
      return { rule, match: m[0], player: player ? player.trim() : null };
    }
  }
  return null;
}

/**
 * 分类一条“接受之后”系统消息的 tpa 结果（用于日志与重发判断）。
 * @returns {'accepted'|'rejected'|'unknown'|null} null=与该 bot 状态无关
 */
function classifyResult(raw) {
  const text = toPlain(raw);
  if (!text) return null;
  for (const re of BUILTIN_RESULT_RULES.reject) if (re.test(text)) return 'rejected';
  // 与传送相关才判为本 bot 的传送结果
  if (!/tpa|传送|瞬移|teleport\b|teleportation/i.test(text)) return null;
  for (const re of BUILTIN_RESULT_RULES.accept) if (re.test(text)) return 'accepted';
  return 'unknown';
}

module.exports = {
  BUILTIN_REQUEST_RULES,
  BUILTIN_RESULT_RULES,
  toPlain,
  matchRequest,
  resolveRequestRules,
  classifyResult
};
