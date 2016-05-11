'use strict'

var crypto = require('crypto')
var EventEmitter = require('events')
var async = require('async')
var bitcoinjs = require('bitcoinjs-lib')
var hash160 = bitcoinjs.crypto.hash160
var HDNode = bitcoinjs.HDNode
var Script = bitcoinjs.script
var Address = bitcoinjs.address
var debug = require('debug')('bitcoin-wallet')
var inherits = require('inherits')
var pumpify = require('pumpify').obj
var sublevel = require('level-sublevel')
var transaction = require('level-transactions')
var to = require('flush-write-stream').obj
var createFilterStream = require('./filterStream.js')
var pkg = require('../package.json')

function assertValidParams (params) {
  if (params == null) {
    throw new Error('Must provide wallet params')
  }
  if (params.bip32 == null) {
    throw new Error('Params must have "bip32" property')
  }
  if (params.messagePrefix == null) {
    throw new Error('Params must have "messagePrefix" property')
  }
  if (params.bip32.public == null) {
    throw new Error('Params must have "bip32.public" property')
  }
  if (params.bip32.private == null) {
    throw new Error('Params must have "bip32.private" property')
  }
  if (params.pubKeyHash == null) {
    throw new Error('Params must have "pubKeyHash" property')
  }
  if (params.scriptHash == null) {
    throw new Error('Params must have "scriptHash" property')
  }
  if (params.wif == null) {
    throw new Error('Params must have "wif" property')
  }
  if (params.dustThreshold == null) {
    throw new Error('Params must have "dustThreshold" property')
  }
}

// TODO: support pubkey-only mode (tracks transactions but can't spend)

function Wallet (params, db, opts) {
  assertValidParams(params)
  if (!db) throw new Error('"db" argument is required')

  if (!(this instanceof Wallet)) return new Wallet(db, opts)
  EventEmitter.call(this)

  this.params = params
  this.db = sublevel(db)
  // TODO: create wrappers for these stores to make them smarter (rather than always using raw put/get)
  this.meta = this.db.sublevel('m', { valueEncoding: 'json' })
  this.unspent = this.db.sublevel('u', { valueEncoding: 'json' })
  this.transactions = this.db.sublevel('t', { valueEncoding: 'binary' })
  this.keys = this.db.sublevel('k')
  this.blocks = this.db.sublevel('b', { valueEncoding: 'json' })
  opts = opts || {}
  this.lookAhead = opts.lookAhead || 100

  this._loadMeta(opts, (err) => {
    if (err) return this._error(err)
    this.deriveKey = this.key.deriveHardened(0).neutered()
    this._updateKeys((err) => {
      if (err) return this._error(err)
      this.ready = true
      this.emit('ready')
    })
  })
}
inherits(Wallet, EventEmitter)

Wallet.prototype._error = function (err) {
  this.emit('error', err)
}

Wallet.prototype.onceReady = function (cb) {
  if (this.ready) return cb()
  this.once('ready', cb)
}

Wallet.prototype.getAddress = function (key) {
  var redeem = this._redeemScript(key.getPublicKeyBuffer())
  return Address.toBase58Check(hash160(redeem), this.params.scriptHash)
}

Wallet.prototype.createAddress = function (cb) {
  this.createKey((err, key) => {
    if (err) return cb(err)
    cb(null, this.getAddress(key))
  })
}

Wallet.prototype.createKey = function (cb) {
  var meta = transaction(this.meta, { valueEncoding: 'json' })
  var key = this._derive(this.sync.keys.used)
  this.sync.keys.used++
  meta.put('sync', this.sync)
  meta.commit((err) => {
    if (err) return cb(err)
    cb(null, key)
  })
}

Wallet.prototype.createWriteStream = function () {
  var filterStream = createFilterStream(this.keys)
  var processStream = to((block, enc, cb) => this.processBlock(block, cb))
  var writeStream = pumpify(filterStream, processStream)
  writeStream.on('error', this._error.bind(this))
  return writeStream
}

Wallet.prototype.processBlock = function (data, cb) {
  var db = transaction(this.db, { valueEncoding: 'json' })

  this.sync.height = data.block.height
  this.sync.hash = data.block.header.getHash().toString('base64')

  if (data.relevant.length === 0) {
    db.put('sync', this.sync, { prefix: this.meta })
    db.commit(cb)
    this.emit('sync', this.sync)
    return
  }

  var txHashes = []
  var highestKey = this.sync.keys.used
  for (let tx of data.relevant) {
    var hash = tx.tx.getHash().toString('base64')
    txHashes.push(hash)
    // TODO: decide: should we be storing whole transaction or only relevant ins/outs?
    db.put(hash, tx.tx.toBuffer(), { prefix: this.transactions, valueEncoding: 'binary' })

    for (let input of tx.relevant.ins) {
      db.del(`${input.hash.toString('base64')}:${input.index}`, { prefix: this.unspent })
    }

    for (let output of tx.relevant.outs) {
      db.put(`${hash}:${output.index}`, output, { prefix: this.unspent })
      highestKey = Math.max(highestKey, output.key.index)
    }
  }

  db.put(data.block.header.getHash().toString('base64'), txHashes, { prefix: this.blocks })
  // TODO: save in binary

  this.sync.keys.used = highestKey + 1
  this._updateKeys(db, (err, keys) => {
    if (err) return cb(err)

    db.put('sync', this.sync, { prefix: this.meta })
    db.commit(cb)
  })
}

Wallet.prototype._loadMeta = function (opts, cb) {
  if (this.ready) return cb(new Error('Cannot call "_loadMeta" after ready'))
  async.map([ 'sync', 'info', 'key' ], this.meta.get.bind(this.meta),
  (err, res) => {
    if (err && !err.notFound) return cb(err)
    if (err && err.notFound) return this._initializeMeta(opts, cb)
    this.sync = res[0]
    this.info = res[1]
    this.key = HDNode.fromSeedBuffer(new Buffer(res[2].seed, 'base64'))
    cb(null)
  })
}

Wallet.prototype._initializeMeta = function (opts, cb) {
  if (this.ready) return cb(new Error('Cannot call "_initializeMeta" after ready'))
  // first, ensure none of the meta keys are set to prevent writing over any
  // existing data
  async.each([ 'sync', 'info', 'key' ], (key, cb) => {
    this.meta.get(key, (err, res) => {
      if (err && !err.notFound) return cb(err)
      if (res) cb(new Error(`Existing meta key: ${key}`))
      cb(null)
    })
  }, (err) => {
    if (err) return cb(err)
    this.sync = {
      height: 0,
      hash: null,
      keys: {
        derived: 0,
        used: 0
      }
    }
    this.info = {
      date: opts.date != null ? opts.date : Date.now(),
      version: pkg.version
    }
    crypto.randomBytes(64, (err, seed) => {
      if (err) return cb(err)
      this.key = HDNode.fromSeedBuffer(seed, this.params)
      this.meta.batch([
        { type: 'put', key: 'sync', value: this.sync },
        { type: 'put', key: 'info', value: this.info },
        { type: 'put', key: 'key', value: {
          seed: seed.toString('base64')
        } }
      ], cb)
    })
  })
}

Wallet.prototype._derive = function (i, hardened) {
  var key = this.deriveKey
  return hardened ? key.deriveHardened(i) : key.derive(i)
}

// returns derived keys from index 'from' to 'used'+'lookAhead'
Wallet.prototype._deriveRange = function (from) {
  debug(`_deriveRange, from=${from}`)
  var keyIndex = this.sync.keys.used + this.lookAhead
  var derived = []
  for (var i = from; i < keyIndex; i++) {
    derived.push(this._derive(i))
  }
  debug(`_deriveRange done`)
  return derived
}

// derives any keys up to used+lookAhead, saves to key store, emits 'filteradd'
Wallet.prototype._updateKeys = function (db, cb) {
  var shouldCommit = false
  if (typeof db === 'function') {
    cb = db
    db = transaction(this.db)
    shouldCommit = true
  }

  var from = this.sync.keys.derived
  var to = this.sync.keys.used + this.lookAhead
  if (from === to) return cb(null)
  debug(`updating wallet keys. from=${from}, to=${to}`)

  var keys = this._deriveRange(from)
  var filterElements = []
  for (let i = 0; i < keys.length; i++) {
    let key = keys[i]
    let index = from + i
    let elements = this._keyElements(key)
    for (let element of elements) {
      db.put(element.toString('base64'), index, { prefix: this.keys })
    }
    filterElements.push(elements)
  }

  this.sync.keys.derived = to
  db.put('sync', this.sync, { prefix: this.meta, valueEncoding: 'json' })

  if (this.ready) {
    this.emit('filteradd', [].concat(...filterElements))
  }

  if (shouldCommit) db.commit(cb)
  else cb(null)
}

Wallet.prototype._redeemScript = function (pubkey) {
  return Script.pubKeyOutput(pubkey)
}

Wallet.prototype._keyElements = function (key) {
  var pubkeyBuffer = key.getPublicKeyBuffer()
  return [ pubkeyBuffer, hash160(this._redeemScript(pubkeyBuffer)) ]
}

Wallet.prototype.filterElements = function (cb) {
  this.onceReady(() => {
    var keys = this._deriveRange(0)
    var elements = keys.map(this._keyElements.bind(this))
    cb([].concat(...elements))
  })
}

module.exports = Wallet
