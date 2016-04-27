var crypto = require('crypto')
var EventEmitter = require('events')
var async = require('async')
var bitcoinjs = require('bitcoinjs-lib')
var HDNode = bitcoinjs.HDNode
var Script = bitcoinjs.script
var inherits = require('inherits')
var sublevel = require('level-sublevel')
var to = require('flush-write-stream').obj
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
  this.meta = this.db.sublevel('m', { valueEncoding: 'json' })
  this.unspent = this.db.sublevel('u')
  this.transactions = this.db.sublevel('t')
  this.keys = this.db.sublevel('k')
  this.blocks = this.db.sublevel('b')
  opts = opts || {}
  this.lookAhead = opts.lookAhead || 100

  this._loadMeta(opts, (err) => {
    if (err) return this._error(err)
    this.pubKey = this.key.getPublicKeyBuffer()
    this.deriveKey = this.key.deriveHardened(0)
    this.ready = true
    this.emit('ready')
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

Wallet.prototype.createWriteStream = function (opts) {
  return to((block, enc, cb) => this._processBlock(block, cb))
}

Wallet.prototype._processBlock = function (block, cb) {
  async.each(block.transactions, (tx, cb) => {

  }, cb)
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
        seen: 0
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
          pubKey: this.key.getPublicKeyBuffer().toString('base64'),
          seed: seed.toString('base64')
        } }
      ], cb)
    })
  })
}

Wallet.prototype._derive = function (i, cb) {
  return this.deriveKey.derive(i)
}

Wallet.prototype._deriveAll = function (cb) {
  var keyIndex = this.sync.keys.seen + this.lookAhead
  var derived = []
  for (var i = 0; i < keyIndex; i++) {
    derived.push(this._derive(i))
  }
  this.sync.keys.derived = keyIndex
  this.meta.put('sync', this.sync, (err) => {
    if (err) return cb(err)
    cb(null, derived)
  })
}

Wallet.prototype._keyElements = function (key) {
  return [
    key.getPublicKeyBuffer(),
    key.getIdentifier()
  ]
}

Wallet.prototype.filterElements = function (cb) {
  this.onceReady(() => {
    this._deriveAll((err, keys) => {
      if (err) return cb(err)
      var elements = keys.map(this._keyElements.bind(this))
      cb(null, [].concat.apply([], elements))
    })
  })
}

module.exports = Wallet
