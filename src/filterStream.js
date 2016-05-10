'use strict'

var TransformStream = require('stream').Transform
var async = require('async')
var debug = require('debug')('bitcoin-wallet:filterStream')
var old = require('old')
var Script = require('bitcoinjs-lib').script

class FilterStream extends TransformStream {
  constructor (keyStore) {
    super({ objectMode: true })
    this.keys = keyStore
  }

  _transform (block, enc, cb) {
    var relevantTxs = []
    async.each(block.transactions, (tx, cb) => {
      this.getRelevant(tx, (err, relevant) => {
        if (err) return cb(err)
        if (relevant.ins.length === 0 && relevant.outs.length === 0) return cb(null)
        debug('saw relevant transaction: ' +
          `${relevant.ins.length} inputs, ${relevant.outs.length} outputs, ` +
          `txid=${tx.getId()}`)
        relevantTxs.push({ tx, relevant })
        cb(null)
      })
    }, (err) => {
      if (err) return cb(err)
      cb(null, { block, relevant: relevantTxs })
    })
  }

  getRelevant (tx, cb) {
    var relevant = { ins: [], outs: [] }
    async.forEachOf(tx.ins, (input, index, cb) => {
      this.getInputKey(input, (err, key) => {
        if (err) return cb(err)
        if (key) relevant.ins.push(Object.assign({ key, index }, input))
        cb(null)
      })
    }, (err) => {
      if (err) return cb(err)
      async.forEachOf(tx.outs, (output, index, cb) => {
        this.getOutputKey(output, (err, key) => {
          if (err) return cb(err)
          if (key) relevant.outs.push(Object.assign({ key, index }, output))
          cb(null)
        })
      }, (err) => {
        if (err) return cb(err)
        cb(null, relevant)
      })
    })
  }

  getInputKey (input, cb) {
    if (!Script.isScriptHashInput(input.script)) {
      return cb(null, null)
    }
    var script = Script.decompile(input.script)
    var redeemScript = script[script.length - 1]
    if (!Script.isPubKeyOutput(redeemScript)) {
      return cb(null, null)
    }
    var pubkey = Script.decompile(redeemScript)[0]
    this.keys.get(pubkey.toString('base64'), (err, index) => {
      if (err && !err.notFound) return cb(err)
      index = +index
      var key = this._derive(index)
      return cb(null, key)
    })
  }

  getOutputKey (output, cb) {
    if (!Script.isScriptHashOutput(output.script)) {
      return cb(null, null)
    }
    var scriptHash = Script.decompile(output.script)[1]
    this.keys.get(scriptHash.toString('base64'), (err, index) => {
      if (err && !err.notFound) return cb(err)
      index = +index
      var key = this._derive(index)
      return cb(null, { key, index })
    })
  }
}

module.exports = old(FilterStream)
