'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  matchRequest, resolveRequestRules, classifyResult, toPlain
} = require('../src/regexes');

test('内置规则能匹配常见中文 tpa 请求', () => {
  const rules = resolveRequestRules({ name: 's', tpa: {} }, null);
  let hit = matchRequest(rules, '§6Steve§r 请求传送到你的位置');
  assert.ok(hit, '应命中中文 tpa 请求');
  assert.strictEqual(hit.rule.type, 'tpa');
  assert.strictEqual(hit.rule.requestCommand, '/tpaccept');
});

test('内置规则能匹配常见英文 tpa 请求', () => {
  const rules = resolveRequestRules({ name: 's', tpa: {} }, null);
  const hit = matchRequest(rules, '[WARN] Steve has requested to teleport to you. /tpaccept to accept.');
  assert.ok(hit, '应命中英文 tpa 请求');
  assert.strictEqual(hit.rule.requestCommand, '/tpaccept');
});

test('服务器可自定义正则并覆盖内置', () => {
  const scfg = {
    name: 'custom',
    tpa: {
      patternsOverride: true,
      patterns: [
        { regex: '自定义插件提示 (.+?) 请求', type: 'tpahere' },
        { regex: 'some plugin says (.+?) want tp' }
      ]
    }
  };
  const rules = resolveRequestRules(scfg, null);
  const hit = matchRequest(rules, '自定义插件提示 Steve 请求');
  assert.ok(hit);
  assert.strictEqual(hit.rule.type, 'tpahere');

  const hit2 = matchRequest(rules, 'some plugin says Alex want tp');
  assert.ok(hit2);
  assert.strictEqual(hit2.rule.type, 'tpa'); // 默认 type
});

test('accept=false 的任务用拒绝命令', () => {
  const scfg = { name: 'd', tpa: { patternsOverride: true, patterns: [{ regex: '拒绝我吧', accept: false, denyCommand: '/tpdeny' }] } };
  const rules = resolveRequestRules(scfg, null);
  const hit = matchRequest(rules, '拒绝我吧');
  assert.ok(hit);
  assert.strictEqual(hit.rule.accept, false);
});

test('classifyResult 识别接受/拒绝', () => {
  assert.strictEqual(classifyResult('传送请求已被接受'), 'accepted');
  assert.strictEqual(classifyResult('该玩家不在线'), 'rejected');
  assert.strictEqual(classifyResult('你好呀'), null); // 无关消息
});

test('toPlain 去除颜色码', () => {
  assert.strictEqual(toPlain('§a§lhello §rworld'), 'hello world');
});

// ---- TPA 白名单：请求者玩家名提取（用户服务器的 TSL 正则场景）----
const USER_REGEX = '\\[TSL\\] ([a-zA-Z0-9_\\u4e00-\\u9fa5]{1,16}) 请求(?:你传送到他的位置|传送到你的位置)';

test('用户 TSL 正则能匹配并提取请求者玩家名', () => {
  const rules = resolveRequestRules({
    name: 'tsl', tpa: { patternsOverride: true, patterns: [{ regex: USER_REGEX, type: 'tpa' }] }
  }, null);
  // 你传送到他的位置 = tpa（请求bot过去）
  const hit1 = matchRequest(rules, '[TSL] Steve 请求你传送到他的位置');
  assert.ok(hit1, '应命中 TSL tpa 请求');
  assert.strictEqual(hit1.player, 'Steve', '应提取到请求者玩家名');
  // 传送到你的位置 = tpahere 请求，同样提取
  const hit2 = matchRequest(rules, '[TSL] 小明 请求传送到你的位置');
  assert.ok(hit2, '应命中 TSL 传送到你');
  assert.strictEqual(hit2.player, '小明', '应提取到中文玩家名');
});

test('matchRequest 提取 player：无捕获组时为 null', () => {
  const rules = resolveRequestRules({ name: 's', tpa: { patternsOverride: true, patterns: [{ regex: '请求传送到你的位置' }] } }, null);
  const hit = matchRequest(rules, '请求传送到你的位置');
  assert.ok(hit);
  assert.strictEqual(hit.player, null);
});

test('resolveRequestRules 忽略非法正则（如 JS 不支持的语法）', () => {
  const rules = resolveRequestRules({ name: 's', tpa: { patternsOverride: true, patterns: [{ regex: '[非法' }] } }, null);
  assert.strictEqual(rules.length, 0, '非法正则应被过滤');
});
