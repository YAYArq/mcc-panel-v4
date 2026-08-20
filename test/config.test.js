'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { loadConfig } = require('../src/config');

function tmpConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afkbot-test-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

test('加载完整的 servers 配置并规范化默认值', () => {
  const file = tmpConfig({
    logLevel: 'debug',
    servers: [
      { name: 'a', host: 'h', port: 25566, username: 'u' }
    ]
  });
  const cfg = loadConfig({ path: file });
  assert.strictEqual(cfg.logLevel, 'debug');
  assert.strictEqual(cfg.servers.length, 1);
  const s = cfg.servers[0];
  assert.strictEqual(s.host, 'h');
  assert.strictEqual(s.port, 25566);
  assert.strictEqual(s.name, 'a');
  assert.strictEqual(s.acceptTpa, true);       // 默认 true
  assert.strictEqual(s.enabled, true);
  assert.deepStrictEqual(s.scheduledCommands, []);
  assert.deepStrictEqual(s.scheduledActions, []);
});

test('缺少 host 的服务器会被禁用', () => {
  const file = tmpConfig({
    servers: [{ name: 'bad', username: 'u' }]
  });
  const cfg = loadConfig({ path: file });
  assert.strictEqual(cfg.servers[0].enabled, false);
});

test('config.local.json 叠加覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afkbot-local-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ logLevel: 'info', servers: [] }, null, 2));
  fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({ logLevel: 'error' }, null, 2));
  const cfg = loadConfig({ path: file });
  assert.strictEqual(cfg.logLevel, 'error');
});
