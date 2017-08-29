'use strict'

const resources = require('./../resources')

module.exports = (server) => {
  const api = server.select('API')
  const gateway = server.select('Gateway')

  api.route({
    // TODO fix method
    method: '*',
    path: '/api/v0/cat',
    config: {
      pre: [
        { method: resources.files.cat.parseArgs, assign: 'args' }
      ],
      handler: resources.files.cat.handler
    }
  })

  api.route({
    // TODO fix method
    method: '*',
    path: '/api/v0/get',
    config: {
      pre: [
        { method: resources.files.get.parseArgs, assign: 'args' }
      ],
      handler: resources.files.get.handler
    }
  })

  api.route({
    // TODO fix method
    method: '*',
    path: '/api/v0/add',
    config: {
      payload: {
        parse: false,
        output: 'stream'
      },
      handler: resources.files.add.handler
    }
  })

  gateway.route({
    method: '*',
    path: '/ipfs/{hash*}',
    config: {
      pre: [
        { method: resources.files.gateway.checkHash, assign: 'args' }
      ],
      handler: resources.files.gateway.handler
    }
  })
}
