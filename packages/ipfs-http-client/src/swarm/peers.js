'use strict'

const multiaddr = require('multiaddr')
/** @typedef { import("./../lib/api") } API */

module.exports = (/** @type {API} */ api) => {
  return async (options = {}) => {
    const res = await (await api.post('swarm/peers', {
      timeout: options.timeout,
      signal: options.signal,
      searchParams: options
    })).json()

    return (res.Peers || []).map(peer => {
      const info = {}
      try {
        info.addr = multiaddr(peer.Addr)
        info.peer = peer.Peer
      } catch (error) {
        info.error = error
        info.rawPeerInfo = peer
      }
      if (peer.Muxer) {
        info.muxer = peer.Muxer
      }
      if (peer.Latency) {
        info.latency = peer.Latency
      }
      if (peer.Streams) {
        info.streams = peer.Streams
      }
      if (peer.Direction != null) {
        info.direction = peer.Direction
      }
      return info
    })
  }
}
