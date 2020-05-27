/* eslint max-nested-callbacks: ["error", 8] */
'use strict'

const { DAGNode, DAGLink } = require('ipld-dag-pb')
const CID = require('cids')
const { default: Queue } = require('p-queue')
const { Key } = require('interface-datastore')
const errCode = require('err-code')
const multicodec = require('multicodec')
const dagCborLinks = require('dag-cbor-links')
const debug = require('debug')
const { Buffer } = require('buffer')
const { cidToString } = require('../../../utils/cid')

const createPinSet = require('./pin-set')

const { Errors } = require('interface-datastore')
const ERR_NOT_FOUND = Errors.notFoundError().code

// arbitrary limit to the number of concurrent dag operations
const WALK_DAG_CONCURRENCY_LIMIT = 300
const IS_PINNED_WITH_TYPE_CONCURRENCY_LIMIT = 300
const PIN_DS_KEY = new Key('/local/pins')

/**
 * @param {string} type
 * @returns {Error}
 */
function invalidPinTypeErr (type) {
  const errMsg = `Invalid type '${type}', must be one of {direct, indirect, recursive, all}`
  return errCode(new Error(errMsg), 'ERR_INVALID_PIN_TYPE')
}

/**
 * @typedef {'direct'|'recursive'|'indirect'|'all'} PinType
 * @type {Record<string, PinType>}
 */
const PinTypes = {
  direct: 'direct',
  recursive: 'recursive',
  indirect: 'indirect',
  all: 'all'
}

/**
 * @typedef {import('../index').DAG} DAG
 * @typedef {import('ipfs-repo')} Repo
 */

class PinManager {
  /**
   * @param {Repo} repo
   * @param {DAG} dag
   */
  constructor (repo, dag) {
    this.repo = repo
    this.dag = dag
    this.log = debug('ipfs:pin')
    this.pinset = createPinSet(dag)
    this.directPins = new Set()
    this.recursivePins = new Set()
  }

  /**
   * @param {Object} options
   * @param {CID|string} options.cid
   * @param {boolean} [options.preload]
   * @param {function(CID):void} [options.onCid]
   */
  async _walkDag ({ cid, preload = false, onCid = () => {} }) {
    if (!CID.isCID(cid)) {
      // @ts-ignore
      cid = new CID(cid)
    }

    /**
     * @param {CID} cid
     * @returns {*}
     */
    const walk = (cid) => {
      return async () => {
        const { value: node } = await this.dag.get(cid, '/', { preload })

        onCid(cid)

        if (cid.codec === 'dag-pb') {
          const dagPBNode = /** @type {DAGNode} */(node)
          queue.addAll(
            dagPBNode.Links.map(link => walk(link.Hash))
          )
        } else if (cid.codec === 'dag-cbor') {
          for (const [_, childCid] of dagCborLinks(node)) { // eslint-disable-line no-unused-vars
            queue.add(walk(childCid))
          }
        }
      }
    }

    const queue = new Queue({
      concurrency: WALK_DAG_CONCURRENCY_LIMIT
    })
    queue.add(walk(/** @type {CID} */(cid)))

    await queue.onIdle()
  }

  directKeys () {
    return Array.from(this.directPins, key => new CID(key).buffer)
  }

  recursiveKeys () {
    return Array.from(this.recursivePins, key => new CID(key).buffer)
  }

  /**
   * @param {Object} options
   * @param {boolean} [options.preload]
   * @returns {Promise<string[]>}
   */
  async getIndirectKeys ({ preload }) {
    const indirectKeys = new Set()

    for (const multihash of this.recursiveKeys()) {
      await this._walkDag({
        cid: new CID(multihash),
        preload: preload || false,
        /**
         * @param {CID} input
         */
        onCid: (input) => {
          const cid = input.toString()

          // recursive pins pre-empt indirect pins
          if (!this.recursivePins.has(cid)) {
            indirectKeys.add(cid)
          }
        }
      })
    }

    return Array.from(indirectKeys)
  }

  // Encode and write pin key sets to the datastore:
  // a DAGLink for each of the recursive and direct pinsets
  // a DAGNode holding those as DAGLinks, a kind of root pin
  async flushPins () {
    const [
      dLink,
      rLink
    ] = await Promise.all([
      // create a DAGLink to the node with direct pins
      this.pinset.storeSet(this.directKeys())
        .then((result) => {
          return new DAGLink(PinTypes.direct, result.node.size, result.cid)
        }),
      // create a DAGLink to the node with recursive pins
      this.pinset.storeSet(this.recursiveKeys())
        .then((result) => {
          return new DAGLink(PinTypes.recursive, result.node.size, result.cid)
        }),
      // the pin-set nodes link to a special 'empty' node, so make sure it exists
      this.dag.put(new DAGNode(Buffer.alloc(0)), {
        version: 0,
        format: multicodec.DAG_PB,
        hashAlg: multicodec.SHA2_256,
        preload: false
      })
    ])

    // create a root node with DAGLinks to the direct and recursive DAGs
    const rootNode = new DAGNode(Buffer.alloc(0), [dLink, rLink])
    const rootCid = await this.dag.put(rootNode, {
      version: 0,
      format: multicodec.DAG_PB,
      hashAlg: multicodec.SHA2_256,
      preload: false
    })

    // save root to datastore under a consistent key
    await this.repo.datastore.put(PIN_DS_KEY, rootCid.buffer)

    this.log(`Flushed pins with root: ${rootCid}`)
  }

  async load () {
    const has = await this.repo.datastore.has(PIN_DS_KEY)

    if (!has) {
      return
    }

    const mh = await this.repo.datastore.get(PIN_DS_KEY)
    const pinRoot = await this.dag.get(new CID(mh), '', { preload: false })

    const [
      rKeys, dKeys
    ] = await Promise.all([
      this.pinset.loadSet(pinRoot.value, PinTypes.recursive),
      this.pinset.loadSet(pinRoot.value, PinTypes.direct)
    ])

    this.directPins = new Set(dKeys.map(k => cidToString(k)))
    this.recursivePins = new Set(rKeys.map(k => cidToString(k)))

    this.log('Loaded pins from the datastore')
  }

  /**
   * @typedef {Object} PinInfo
   * @property {string} key
   * @property {boolean} pinned
   * @property {CID|string|void} [reason]
   *
   * @param {Buffer|CID} multihash
   * @param {PinType} type
   * @returns {Promise<PinInfo>}
   */
  async isPinnedWithType (multihash, type) {
    const key = cidToString(multihash)
    const { recursive, direct, all } = PinTypes

    // recursive
    if ((type === recursive || type === all) && this.recursivePins.has(key)) {
      return {
        key,
        pinned: true,
        reason: recursive
      }
    }

    if (type === recursive) {
      return {
        key,
        pinned: false
      }
    }

    // direct
    if ((type === direct || type === all) && this.directPins.has(key)) {
      return {
        key,
        pinned: true,
        reason: direct
      }
    }

    if (type === direct) {
      return {
        key,
        pinned: false
      }
    }

    // indirect (default)
    // check each recursive key to see if multihash is under it
    // arbitrary limit, enables handling 1000s of pins.
    const queue = new Queue({
      concurrency: IS_PINNED_WITH_TYPE_CONCURRENCY_LIMIT
    })
    let cid

    queue.addAll(
      this.recursiveKeys()
        .map(childKey => {
          const childCID = new CID(childKey)

          return async () => {
            const has = await this.pinset.hasDescendant(childKey, childCID)

            if (has) {
              cid = childCID
              queue.clear()
            }
          }
        })
    )

    await queue.onIdle()

    return {
      key,
      pinned: Boolean(cid),
      reason: cid
    }
  }

  // Gets CIDs of blocks used internally by the pinner
  async getInternalBlocks () {
    let mh

    try {
      mh = await this.repo.datastore.get(PIN_DS_KEY)
    } catch (err) {
      if (err.code === ERR_NOT_FOUND) {
        this.log('No pinned blocks')

        return []
      }

      throw new Error(`Could not get pin sets root from datastore: ${err.message}`)
    }

    const cid = new CID(mh)
    const obj = await this.dag.get(cid, '', { preload: false })

    // The pinner stores an object that has two links to pin sets:
    // 1. The directly pinned CIDs
    // 2. The recursively pinned CIDs
    // If large enough, these pin sets may have links to buckets to hold
    // the pins
    const cids = await this.pinset.getInternalCids(obj.value)

    return cids.concat(cid)
  }

  /**
   * @param {CID|string} cid
   * @param {Object} options
   * @param {boolean} [options.preload]
   * @param {AbortSignal} [options.signal]
   */
  async fetchCompleteDag (cid, options) {
    await this._walkDag({
      cid,
      preload: options.preload
    })
  }

  // Returns an error if the pin type is invalid
  /**
   * @param {PinType} type
   * @returns {void|Error}
   */
  static checkPinType (type) {
    if (typeof type !== 'string' || !Object.keys(PinTypes).includes(type)) {
      return invalidPinTypeErr(type)
    }
  }
}

PinManager.PinTypes = PinTypes

module.exports = PinManager
