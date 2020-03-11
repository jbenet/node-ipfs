'use strict'

const { Buffer } = require('buffer')
const ndjson = require('iterable-ndjson')
const toIterable = require('stream-to-it/source')
const encodeBufferURIComponent = require('../lib/encode-buffer-uri-component')

/** @typedef { import("./../lib/api") } API */

module.exports = (/** @type {API} */ api) => {
  return async function get (key, options = {}) {
    if (!Buffer.isBuffer(key)) {
      throw new Error('invalid key')
    }

    options.key = encodeBufferURIComponent(key)
    const res = await api.post('dht/get', {
      timeout: options.timeout,
      signal: options.signal,
      searchParams: options
    })

    for await (const message of ndjson(toIterable(res.body))) {
      // 3 = QueryError
      // https://github.com/libp2p/go-libp2p-core/blob/6e566d10f4a5447317a66d64c7459954b969bdab/routing/query.go#L18
      // https://github.com/ipfs/go-ipfs/blob/eb11f569b064b960d1aba4b5b8ca155a3bd2cb21/core/commands/dht.go#L472-L473
      if (message.Type === 3) {
        throw new Error(message.Extra)
      }

      // 5 = Value
      // https://github.com/libp2p/go-libp2p-core/blob/6e566d10f4a5447317a66d64c7459954b969bdab/routing/query.go#L21
      if (message.Type === 5) {
        return message.Extra
      }
    }

    throw new Error('not found')
  }
}
