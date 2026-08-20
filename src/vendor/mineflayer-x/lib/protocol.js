/**
 * Register MC 26.1 with minecraft-protocol.
 *
 * Adds '26.1' to the supported versions list so createClient()
 * and createServer() accept version: '26.1'.
 */

'use strict'

module.exports = function registerProtocol () {
  const mcpVersion = require('minecraft-protocol/src/version')
  if (!mcpVersion.supportedVersions.includes('26.1')) {
    mcpVersion.supportedVersions.push('26.1')
  }
}
