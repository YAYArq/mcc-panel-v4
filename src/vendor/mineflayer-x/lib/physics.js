/**
 * Register MC 26.1 physics features with prismarine-physics.
 *
 * 26.1 physics are identical to 1.21. Verified from decompiled
 * LivingEntity.java — same gravity model, same liquid physics.
 *
 * Only one feature survives to 1.21+: proportionalLiquidGravity
 *   waterGravity = gravity / 16
 *   lavaGravity = gravity / 4
 */

'use strict'

module.exports = function registerPhysics () {
  const physicsFeatures = require('prismarine-physics/lib/features.json')
  for (const feature of physicsFeatures) {
    if (feature.versions.includes('1.21') && !feature.versions.includes('26.1')) {
      feature.versions.push('26.1')
    }
  }
}
