'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { Scheduler, parseCron, cronMatches } = require('../src/scheduler');

test('parseCron 标准5字段', () => {
  assert.ok(parseCron('0 3 * * *'));
  assert.ok(parseCron('*/30 * * * *'));
  assert.ok(parseCron('0 9 * * 1-5'));
  assert.ok(parseCron('30 4 * * 0'));
});

test('parseCron 非法表达式返回 null', () => {
  assert.strictEqual(parseCron('不是数字 * * * *'), null);
  assert.strictEqual(parseCron('0 3 * *'), null); // 只有4字段
  assert.strictEqual(parseCron('61 * * * *'), null); // 分钟超界
});

test('cronMatches 匹配具体时间', () => {
  const cron = parseCron('30 4 * * 0'); // 周日 04:30
  assert.ok(cron);
  // 周日 04:30
  assert.strictEqual(cronMatches(cron, new Date(2024, 6, 14, 4, 30)), true); // 2024-07-14 周日
  assert.strictEqual(cronMatches(cron, new Date(2024, 6, 15, 4, 30)), false); // 周一
  assert.strictEqual(cronMatches(cron, new Date(2024, 6, 14, 5, 30)), false); // 周日的05:30
});

test('Scheduler every 触发', () => {
  const s = new Scheduler({ tickMs: 5 });
  let fires = 0;
  let t0 = 0;
  s.add({ name: 't', every: 10, onFire: () => { fires++; t0 = Date.now(); } });
  s._tick();
  assert.strictEqual(fires, 1); // 首次立即触发
  s._tick();                     // 未到间隔
  assert.strictEqual(fires, 1);
  // 模拟 time 推进
  s.tasks[0].lastFire = Date.now() - 100;
  s._tick();
  assert.strictEqual(fires, 2);
  s.stop();
});

test('Scheduler cron 同分钟只触发一次', () => {
  const s = new Scheduler({ tickMs: 5 });
  let fires = 0;
  s.add({ name: 'c', cron: '* * * * *', onFire: () => fires++ });
  s._tick();
  s._tick(); // 第二次同分钟不应再触发
  assert.strictEqual(fires, 1);
  s.stop();
});
