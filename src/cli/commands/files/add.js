'use strict'

const Command = require('ronin').Command
const utils = require('../../utils')
const debug = require('debug')
const log = debug('cli:version')
log.error = debug('cli:version:error')
const bs58 = require('bs58')
const streamifier = require('streamifier')
const fs = require('fs')
const async = require('async')
const pathj = require('path')
const glob = require('glob')

module.exports = Command.extend({
  desc: 'Add a file to IPFS using the UnixFS data format',

  options: {
    recursive: {
      alias: 'r',
      type: 'boolean',
      default: false
    }
  },

  run: (recursive, path) => {
    let s

    if (!path) {
      throw new Error('Error: Argument \'path\' is required')
    }

    s = fs.statSync(path)

    if (s.isDirectory() && recursive === false) {
      throw new Error('Error: ' + process.cwd() + ' is a directory, use the \'-r\' flag to specify directories')
    }
    if (path === '.' && recursive === true) {
      path = process.cwd()
      s = fs.statSync(process.cwd())
    } else if (path === '.' && recursive === false) {
      s = fs.statSync(process.cwd())
      if (s.isDirectory()) {
        throw new Error('Error: ' + process.cwd() + ' is a directory, use the \'-r\' flag to specify directories')
      }
    }

    glob(pathj.join(path, '/**/*'), (err, res) => {
      if (err) {
        throw err
      }
      if (res.length === 0) {
        res = pathj.join(process.cwd(), path)
      }
      utils.getIPFS((err, ipfs) => {
        if (err) {
          throw err
        }
        if (utils.isDaemonOn()) {
          throw new Error('daemon running is not supported yet')
        }
        const i = ipfs.files.add()
        i.on('data', (file) => {
          console.log('added', bs58.encode(file.multihash).toString(), file.path)
        })
        if (res.length !== 0) {
          const index = path.lastIndexOf('/')
          async.eachLimit(res, 10, (element, callback) => {
            const addPath = element.substring(index + 1, element.length)
            if (fs.statSync(element).isDirectory()) {
              callback()
            } else {
              const buffered = fs.readFileSync(element)
              const r = streamifier.createReadStream(buffered)
              const filePair = {path: addPath, stream: r}
              i.write(filePair)
              callback()
            }
          }, (err) => {
            if (err) {
              throw err
            }
            i.end()
            return
          })
        } else {
          const buffered = fs.readFileSync(path)
          const r = streamifier.createReadStream(buffered)
          const filePair = {path: path, stream: r}
          i.write(filePair)
          i.end()
        }
      })
    })
  }
})
