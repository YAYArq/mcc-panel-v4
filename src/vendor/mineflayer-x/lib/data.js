/**
 * Register MC 26.1 game data with minecraft-data.
 *
 * Data files in data/ were generated from the 26.1 server JAR (--reports)
 * and decompiled client JAR. Protocol packet definitions extracted from
 * GameProtocols.java registration order.
 *
 * @returns {object} minecraft-data instance for 26.1
 */

'use strict'

const path = require('path')

const DATA_DIR = path.resolve(__dirname, '..', 'data')

module.exports = function registerData () {
  const dataModule = require('minecraft-data/data.js')
  const protocolVersions = require('minecraft-data/minecraft-data/data/pc/common/protocolVersions.json')
  const supportedVersions = require('minecraft-data/minecraft-data/data/pc/common/versions.json')

  if (!dataModule.pc['1.21.11']) {
    throw new Error('mineflayer-x: minecraft-data missing 1.21.11. Upgrade to >=3.105.0.')
  }

  // Register all 19 data files under '26.1'
  dataModule.pc['26.1'] = {
    get attributes () { return require(path.join(DATA_DIR, 'attributes.json')) },
    get blockCollisionShapes () { return require(path.join(DATA_DIR, 'blockCollisionShapes.json')) },
    get blocks () { return require(path.join(DATA_DIR, 'blocks.json')) },
    get biomes () { return require(path.join(DATA_DIR, 'biomes.json')) },
    get enchantments () { return require(path.join(DATA_DIR, 'enchantments.json')) },
    get effects () { return require(path.join(DATA_DIR, 'effects.json')) },
    get entities () { return require(path.join(DATA_DIR, 'entities.json')) },
    get foods () { return require(path.join(DATA_DIR, 'foods.json')) },
    get instruments () { return require(path.join(DATA_DIR, 'instruments.json')) },
    get items () { return require(path.join(DATA_DIR, 'items.json')) },
    get language () { return require(path.join(DATA_DIR, 'language.json')) },
    get loginPacket () { return require(path.join(DATA_DIR, 'loginPacket.json')) },
    get materials () { return require(path.join(DATA_DIR, 'materials.json')) },
    get particles () { return require(path.join(DATA_DIR, 'particles.json')) },
    get protocol () { return require(path.join(DATA_DIR, 'protocol.json')) },
    get recipes () { return require(path.join(DATA_DIR, 'recipes.json')) },
    get sounds () { return require(path.join(DATA_DIR, 'sounds.json')) },
    get tints () { return require(path.join(DATA_DIR, 'tints.json')) },
    get version () { return require(path.join(DATA_DIR, 'version.json')) }
  }

  // Register version entry
  const entry = {
    minecraftVersion: '26.1',
    version: 775,
    dataVersion: 4786,
    usesNetty: true,
    majorVersion: '26.1',
    releaseType: 'release'
  }

  if (!protocolVersions.find(v => v.minecraftVersion === '26.1')) {
    protocolVersions.unshift(entry)
  }
  if (!supportedVersions.includes('26.1')) {
    supportedVersions.push('26.1')
  }

  // Rebuild indexes
  const mcDataModule = require('minecraft-data')
  const indexer = require('minecraft-data/lib/indexer.js')
  mcDataModule.versionsByMinecraftVersion.pc = indexer.buildIndexFromArray(protocolVersions, 'minecraftVersion')
  mcDataModule.postNettyVersionsByProtocolVersion.pc = indexer.buildIndexFromArrayNonUnique(
    protocolVersions.filter(e => e.usesNetty), 'version'
  )

  // Verify
  const mcData = require('minecraft-data')('26.1')
  if (!mcData || mcData.version.version !== 775) {
    throw new Error('mineflayer-x: Failed to register MC 26.1')
  }

  // ---- 修补缺失的方块碰撞形状（mineflayer-x 生成的 26.1 数据不完整，pathfinder 依赖 block.shapes）----
  // 1) 部分方块完全没有 collisionShapes 映射（如 golden_dandelion / potted_golden_dandelion）：映射到空形状（无碰撞）
  // 2) 大量方块（chest/stairs/fence/door/slab/wall 等）有映射但 shapes 字典缺失：
  //    优先借用 1.21.11 同名方块的真实形状（半砖/楼梯/栅栏等按真实碰撞盒处理，寻路才准确）；
  //    1.21.11 也没有的（26.1 新方块）才补默认整方块形状，保证寻路不崩溃
  const blocks26 = require(path.join(DATA_DIR, 'blocks.json'))
  const collision26 = require(path.join(DATA_DIR, 'blockCollisionShapes.json'))
  const oldShapesData = require('minecraft-data/minecraft-data/data/pc/1.21.11/blockCollisionShapes.json')
  const oldBlocksData = require('minecraft-data/minecraft-data/data/pc/1.21.11/blocks.json')
  const shapeByName = new Map() // 1.21.11 方块名 -> 第一个形状碰撞盒（从 blockCollisionShapes 取）
  for (const ob of oldBlocksData) {
    const sid = oldShapesData.blocks[ob.name]
    if (sid !== undefined) {
      const first = Array.isArray(sid) ? sid[0] : sid
      const shape = oldShapesData.shapes[first]
      if (shape) shapeByName.set(ob.name, shape)
    }
  }
  let patchedMissing = 0
  let patchedShapes = 0
  for (const block of blocks26) {
    const shapeId = collision26.blocks[block.name]
    if (shapeId === undefined) {
      collision26.blocks[block.name] = '0' // shapes['0'] = []（无碰撞，如花）
      patchedMissing += 1
    } else {
      // 多状态方块的 shapeId 是数组，逐数字键修补缺失形状
      const ids = Array.isArray(shapeId) ? shapeId : [shapeId]
      const realShape = shapeByName.get(block.name)
      for (const id of ids) {
        if (collision26.shapes[id] === undefined) {
          collision26.shapes[id] = realShape || [[0, 0, 0, 1, 1, 1]] // 真实形状或默认整方块
          patchedShapes += 1
        }
      }
    }
  }
  if (patchedMissing > 0 || patchedShapes > 0) {
    console.error(`[mineflayer-x] 已修补 26.1 碰撞形状: 缺失映射 ${patchedMissing} 个, 缺失形状 ${patchedShapes} 个（半砖/楼梯等用 1.21.11 真实形状）`)
  }

  return mcData
}
