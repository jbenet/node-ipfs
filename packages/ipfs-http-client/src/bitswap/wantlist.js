'use strict'

const CID = require('cids')

module.exports = api => {
  return async (peer, options = {}) => {
    if (peer) {
      options.peer = typeof peer === 'string' ? peer : new CID(peer).toString()
    }

    const res = await (await api.post('bitswap/wantlist', {
      timeout: options.timeout,
      signal: options.signal,
      searchParams: options
    })).json()

    return (res.Keys || []).map(k => new CID(k['/']))
  }
}
