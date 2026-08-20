/**
 * Register MC 26.1 with mineflayer.
 *
 * Two things:
 * 1. Version gate — adds 26.1 to testedVersions so createBot() doesn't reject it
 * 2. Time shim — translates 26.1's new WorldClock update_time format to the
 *    {age, time, tickDayTime} format mineflayer's time.js plugin expects
 *
 * Time packet change:
 *   Old (1.21.11): { age: i64, time: i64, tickDayTime: bool }
 *   New (26.1):    { gameTime: i64, clockUpdates: [{clockId, totalTicks, partialTick, rate}] }
 *
 * Clock IDs from WORLD_CLOCK registry:
 *   0 = minecraft:day_time (day/night cycle)
 *
 * Source: decompiled ClientboundSetTimePacket.java, ClockNetworkState.java
 */

'use strict'

module.exports = function registerMineflayer () {
  // Version gate
  const mfVersion = require('mineflayer/lib/version')
  mfVersion.latestSupportedVersion = '26.1'
  if (!mfVersion.testedVersions.includes('26.1')) {
    mfVersion.testedVersions.push('26.1')
  }

  // Time compatibility shim
  const mfModule = require('mineflayer')
  const origCreate = mfModule.createBot.bind(mfModule)

  mfModule.createBot = function (options) {
    const bot = origCreate(options)
    if (options.version === '26.1') {
      installTimeShim(bot)
    }
    return bot
  }
}

function installTimeShim (bot) {
  const client = bot._client
  const origEmit = client.emit.bind(client)

  // 任意数值 -> [hi, lo] 32 位数组（mineflayer time.js 的 longToBigInt 期望格式）
  function toHiLo (v) {
    if (Array.isArray(v)) return [Number(v[0]) | 0, Number(v[1]) >>> 0]
    let n
    try { n = BigInt(v == null ? 0 : v) } catch (e) { n = 0n }
    return [Number(n >> 32n) | 0, Number(n & 0xFFFFFFFFn) >>> 0]
  }

  client.emit = function (event, ...args) {
    if (event === 'update_time' && args[0] && typeof args[0] === 'object') {
      const packet = args[0]

      // 一次性诊断：打印服务器实际发送的 update_time 包结构（确认协议格式）
      if (!installTimeShim._logged) {
        installTimeShim._logged = true
        try {
          console.error('[time-shim] raw update_time:', JSON.stringify(packet, (k, v) => typeof v === 'bigint' ? v.toString() : v))
        } catch (e) { /* ignore */ }
      }

      // 26.1 新格式：{ gameTime, clockUpdates:[{clockId|id,totalTicks,partialTick,rate}] }
      // 实测 26.1.2 服务器 clockUpdates 字段名为 id（mineflayer-x 原代码用 clockId，兼容两者）
      const clocks = Array.isArray(packet.clockUpdates) ? packet.clockUpdates : null
      const dayClock = clocks ? clocks.find(c => c && (c.clockId === 0 || c.id === 0 || c.clockId === 'minecraft:day_time')) : null

      let age, time, tickDayTime
      if (dayClock) {
        const ticks = Number(dayClock.totalTicks) || 0
        time = [Math.floor(ticks / 0x100000000) | 0, (ticks & 0xFFFFFFFF) >>> 0]
        if (dayClock.rate !== undefined) tickDayTime = Number(dayClock.rate) > 0
      }
      // 老格式 / 未知格式兜底：time / age 一律规范化为 [hi, lo]
      if (time === undefined) time = toHiLo(packet.time === undefined ? 0 : packet.time)
      age = toHiLo(packet.gameTime === undefined ? 0 : packet.gameTime)
      if (tickDayTime === undefined) tickDayTime = packet.tickDayTime === undefined ? true : !!packet.tickDayTime

      return origEmit('update_time', { age, time, tickDayTime })
    }
    return origEmit(event, ...args)
  }
}
