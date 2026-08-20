'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeMinecraftVersion } = require('../src/util/version');

test('26.x 系列归一化为 26.1', () => {
  assert.strictEqual(normalizeMinecraftVersion('26.1'), '26.1');
  assert.strictEqual(normalizeMinecraftVersion('26.1.2'), '26.1');
  assert.strictEqual(normalizeMinecraftVersion('26.2'), '26.1');
  assert.strictEqual(normalizeMinecraftVersion('26.2.1'), '26.1');
});

test('非 26.x 版本原样透传', () => {
  assert.strictEqual(normalizeMinecraftVersion('1.21.11'), '1.21.11');
  assert.strictEqual(normalizeMinecraftVersion('1.20.1'), '1.20.1');
});

test('空/未定义返回原值', () => {
  assert.strictEqual(normalizeMinecraftVersion(''), '');
  assert.strictEqual(normalizeMinecraftVersion(undefined), '');
  assert.strictEqual(normalizeMinecraftVersion(null), '');
});
