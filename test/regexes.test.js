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
