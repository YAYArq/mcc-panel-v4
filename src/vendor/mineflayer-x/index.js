/**
 * mineflayer-x
 *
 * Minecraft Java 26.x support for mineflayer and the PrismarineJS ecosystem.
 * Require once before creating any bot — patches are applied at load time.
 *
 *   require('mineflayer-x')
 *   const bot = require('mineflayer').createBot({ version: '26.1', ... })
 *
 * @module mineflayer-x
 * @license MIT
 */

'use strict'

const registerData = require('./lib/data')
const registerProtocol = require('./lib/protocol')
const create261ChunkLoader = require('./lib/chunk')

// 1. Game data (blocks, items, entities, protocol definitions)
const mcData = registerData()

// 2. minecraft-protocol version support
try { registerProtocol() } catch (e) {}

// 3. mineflayer version gate + time shim
try { require('./lib/mineflayer')() } catch (e) {}

// 4. Chunk implementation (handles 26.1's 4-byte section header)
try {
  const chunkModule = require('prismarine-chunk')
  const origExports = chunkModule

  function chunkLoaderWithX (registryOrVersion) {
    const registry = typeof registryOrVersion === 'string'
      ? require('prismarine-registry')(registryOrVersion)
      : registryOrVersion
    if (registry.version?.majorVersion === '26.1') {
      return create261ChunkLoader(registry)
    }
    return origExports(registryOrVersion)
  }

  Object.keys(origExports).forEach(k => { chunkLoaderWithX[k] = origExports[k] })

  for (const p of [require.resolve('prismarine-chunk'), require.resolve('prismarine-chunk/src/index.js')]) {
    if (require.cache[p]) require.cache[p].exports = chunkLoaderWithX
  }
} catch (e) {}

// 5. Physics features
try { require('./lib/physics')() } catch (e) {}

module.exports = {
  version: '26.1',
  protocolVersion: 775,
  mcData
}
