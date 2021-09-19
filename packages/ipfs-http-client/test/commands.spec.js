/* eslint-env mocha */

import { expect } from 'aegir/utils/chai.js'
const f = require('./utils/factory')()

describe('.commands', function () {
  this.timeout(60 * 1000)

  /** @type {import('ipfs-core-types').IPFS} */
  let ipfs

  before(async () => {
    ipfs = (await f.spawn()).api
  })

  after(() => f.clean())

  it('lists commands', async () => {
    const res = await ipfs.commands()

    expect(res).to.exist()
  })
})
