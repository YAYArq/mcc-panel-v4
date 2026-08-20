/**
 * Minecraft 26.1 chunk section parser.
 *
 * 26.1 changed the chunk section header from 2 bytes to 4 bytes:
 *   Old (1.18-1.21.11): short nonEmptyBlockCount | states | biomes
 *   New (26.1+):        short nonEmptyBlockCount | short fluidCount | states | biomes
 *
 * This 2-byte shift breaks every chunk parser that doesn't account for it.
 * Without this fix, the parser reads fluidCount bytes as bitsPerBlock,
 * causing "Bits per block is too big: 17" errors.
 *
 * Source: decompiled net.minecraft.world.level.chunk.LevelChunkSection.java
 *
 * @module mineflayer-x/lib/chunk
 */

'use strict'

function create261ChunkLoader (registry) {
  const Block = require('prismarine-block')(registry)
  const SmartBuffer = require('smart-buffer').SmartBuffer
  const BitArray = require('prismarine-chunk/src/pc/common/BitArrayNoSpan')
  // PaletteChunkSection 在 prismarine-chunk 1.41 导出为工厂 (Block) => class，必须传入 Block 实例化
  const ChunkSection = require('prismarine-chunk/src/pc/common/PaletteChunkSection')(Block)
  const BiomeSection = require('prismarine-chunk/src/pc/common/PaletteBiome')
  const CommonChunkColumn = require('prismarine-chunk/src/pc/common/CommonChunkColumn')
  const constants = require('prismarine-chunk/src/pc/common/constants')
  const neededBits = require('prismarine-chunk/src/pc/common/neededBits')
  const varInt = require('prismarine-chunk/src/pc/common/varInt')
  const { IndirectPaletteContainer, DirectPaletteContainer } = require('prismarine-chunk/src/pc/common/PaletteContainer')

  const noSizePrefix = registry.version['>=']('1.21.5')

  return class ChunkColumn261 extends CommonChunkColumn {
    static get section () { return ChunkSection }

    constructor (options) {
      super(registry)
      // 防御：bot.game.minY/height 若被 26.1 维度解析成非法值（如 0/NaN），回退标准值，
      // 否则 numSections=0 会导致 sections 为空、getBlock 崩溃
      this.minY = Number.isFinite(options?.minY) ? Math.floor(options.minY) : -64
      this.worldHeight = Number.isFinite(options?.worldHeight) && options.worldHeight > 0
        ? Math.floor(options.worldHeight)
        : 384
      this.numSections = this.worldHeight >> 4
      this.maxBitsPerBlock = neededBits(Object.values(registry.blocks).reduce((hi, b) => Math.max(hi, b.maxStateId), 0))
      this.maxBitsPerBiome = neededBits(Object.values(registry.biomes).length)

      this.sections = options?.sections ?? Array.from({ length: this.numSections }, () =>
        new ChunkSection({ noSizePrefix, maxBitsPerBlock: this.maxBitsPerBlock }))
      this.biomes = options?.biomes ?? Array.from({ length: this.numSections }, () =>
        new BiomeSection({ noSizePrefix }))

      this.skyLightMask = options?.skyLightMask ?? new BitArray({ bitsPerValue: 1, capacity: this.numSections + 2 })
      this.emptySkyLightMask = options?.emptySkyLightMask ?? new BitArray({ bitsPerValue: 1, capacity: this.numSections + 2 })
      this.skyLightSections = options?.skyLightSections ?? Array(this.numSections + 2).fill(null)
      this.blockLightMask = options?.blockLightMask ?? new BitArray({ bitsPerValue: 1, capacity: this.numSections + 2 })
      this.emptyBlockLightMask = options?.emptyBlockLightMask ?? new BitArray({ bitsPerValue: 1, capacity: this.numSections + 2 })
      this.blockLightSections = options?.blockLightSections ?? Array(this.numSections + 2).fill(null)
    }

    // ── Block access ──────────────────────────────────────────────

    getBlock (pos) {
      const section = this.sections[(pos.y - this.minY) >> 4]
      const biome = this.getBiome(pos)
      // section 缺失（服务器未下发该 y 层，如全空气层）按空气处理，避免物理模拟崩溃
      const stateId = section ? section.get(toSectionPos(pos, this.minY)) : 0
      const b = Block.fromStateId(stateId, biome?.id ?? 0)
      b.light = this.getBlockLight(pos)
      b.skyLight = this.getSkyLight(pos)
      return b
    }

    getBlockStateId (pos) {
      const section = this.sections[(pos.y - this.minY) >> 4]
      return section ? section.get(toSectionPos(pos, this.minY)) : 0
    }

    setBlockStateId (pos, stateId) {
      const section = this.sections[(pos.y - this.minY) >> 4]
      if (section) section.set(toSectionPos(pos, this.minY), stateId)
    }

    setBlockType (pos, id) {
      this.setBlockStateId(pos, registry.blocks[id].minStateId)
    }

    setBlock (pos, block) {
      this.setBlockStateId(pos, block.stateId)
    }

    // ── Biome access ──────────────────────────────────────────────

    getBiome (pos) {
      const biome = this.biomes[(pos.y - this.minY) >> 4]
      return biome ? biome.get(toBiomePos(pos, this.minY)) : 0
    }

    setBiome (pos, biomeId) {
      this.biomes[(pos.y - this.minY) >> 4].set(toBiomePos(pos, this.minY), biomeId)
    }

    // ── Light access ──────────────────────────────────────────────

    getBlockLight (pos) {
      return readLight(this.blockLightSections[getLightSectionIndex(pos, this.minY)], getSectionBlockIndex(pos, this.minY))
    }

    getSkyLight (pos) {
      return readLight(this.skyLightSections[getLightSectionIndex(pos, this.minY)], getSectionBlockIndex(pos, this.minY))
    }

    setBlockLight (pos, light) {
      const idx = getLightSectionIndex(pos, this.minY)
      let section = this.blockLightSections[idx]
      if (!section) {
        if (light === 0) return
        section = new BitArray({ bitsPerValue: 4, capacity: 4096 })
        this.blockLightMask.set(idx, 1)
        this.blockLightSections[idx] = section
      }
      section.set(getSectionBlockIndex(pos, this.minY), light)
    }

    setSkyLight (pos, light) {
      const idx = getLightSectionIndex(pos, this.minY)
      let section = this.skyLightSections[idx]
      if (!section) {
        if (light === 0) return
        section = new BitArray({ bitsPerValue: 4, capacity: 4096 })
        this.skyLightMask.set(idx, 1)
        this.skyLightSections[idx] = section
      }
      section.set(getSectionBlockIndex(pos, this.minY), light)
    }

    // ── Serialization ─────────────────────────────────────────────

    /**
     * Load chunk data from buffer.
     * Inlines section reading to handle the 4-byte header (with fluidCount).
     */
    load (data) {
      const reader = SmartBuffer.fromBuffer(data)
      for (let i = 0; i < this.numSections; ++i) {
        const solidBlockCount = reader.readInt16BE()
        reader.readInt16BE() // fluidCount — new in 26.1, unused by prismarine

        const bitsPerBlock = reader.readUInt8()
        if (bitsPerBlock === 0) {
          this.sections[i] = new ChunkSection({
            noSizePrefix, solidBlockCount,
            singleValue: varInt.read(reader),
            maxBitsPerBlock: this.maxBitsPerBlock
          })
        } else if (bitsPerBlock > constants.MAX_BITS_PER_BLOCK) {
          this.sections[i] = new ChunkSection({
            noSizePrefix, solidBlockCount,
            data: new DirectPaletteContainer({
              noSizePrefix, bitsPerValue: this.maxBitsPerBlock,
              capacity: constants.BLOCK_SECTION_VOLUME
            }).readBuffer(reader, bitsPerBlock)
          })
        } else {
          const paletteLen = varInt.read(reader)
          const palette = []
          for (let p = 0; p < paletteLen; ++p) palette.push(varInt.read(reader))
          this.sections[i] = new ChunkSection({
            noSizePrefix, solidBlockCount,
            data: new IndirectPaletteContainer({
              noSizePrefix, bitsPerValue: bitsPerBlock,
              capacity: constants.BLOCK_SECTION_VOLUME,
              maxBits: constants.MAX_BITS_PER_BLOCK,
              maxBitsPerBlock: this.maxBitsPerBlock, palette
            }).readBuffer(reader, bitsPerBlock)
          })
        }

        this.biomes[i] = BiomeSection.read(reader, this.maxBitsPerBiome, noSizePrefix)
      }
    }

    dump () {
      const smartBuffer = SmartBuffer.fromSize(this.numSections * 8192)
      for (let i = 0; i < this.numSections; ++i) {
        smartBuffer.writeInt16BE(this.sections[i].solidBlockCount)
        smartBuffer.writeInt16BE(0) // fluidCount
        this.sections[i].write(smartBuffer)
        this.biomes[i].write(smartBuffer)
      }
      return smartBuffer.toBuffer()
    }

    loadParsedLight (skyLight, blockLight, skyLightMask, blockLightMask, emptySkyLightMask, emptyBlockLightMask) {
      function readSection (sections, data, lightMask, pLightMask, emptyMask, pEmptyMask) {
        let currentSectionIndex = 0
        const incomingLightMask = BitArray.fromLongArray(pLightMask, 1)
        const incomingEmptyMask = BitArray.fromLongArray(pEmptyMask, 1)
        for (let y = 0; y < sections.length; y++) {
          const isEmpty = incomingEmptyMask.get(y)
          if (!incomingLightMask.get(y) && !isEmpty) continue
          if (isEmpty) { lightMask.set(y, 0); sections[y] = null }
          else { lightMask.set(y, 1); sections[y] = data[currentSectionIndex] }
          if (!isEmpty) currentSectionIndex++
        }
      }
      readSection(this.skyLightSections, skyLight, this.skyLightMask, skyLightMask, this.emptySkyLightMask, emptySkyLightMask)
      readSection(this.blockLightSections, blockLight, this.blockLightMask, blockLightMask, this.emptyBlockLightMask, emptyBlockLightMask)
    }
  }
}

// ── Helpers (match prismarine-chunk/src/pc/1.18/ChunkColumn.js) ──────────

function readLight (section, index) {
  if (!section) return 0
  if (typeof section.get === 'function') return section.get(index)
  if (Buffer.isBuffer(section) || section instanceof Uint8Array) {
    const byte = section[index >> 1]
    return (index & 1) ? (byte >> 4) & 0xF : byte & 0xF
  }
  return 0
}

function toSectionPos (pos, minY) { return { x: pos.x, y: (pos.y - minY) & 0xF, z: pos.z } }
function toBiomePos (pos, minY) { return { x: pos.x >> 2, y: ((pos.y - minY) & 0xF) >> 2, z: pos.z >> 2 } }
function getLightSectionIndex (pos, minY) { return Math.floor((pos.y - minY) / 16) + 1 }
function getSectionBlockIndex (pos, minY) { return (((pos.y - minY) & 15) << 8) | (pos.z << 4) | pos.x }

module.exports = create261ChunkLoader
