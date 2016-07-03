'use strict';

const EventEmitter = require('events')
const P = require('bluebird')

const CONSTS = require('./constants')


/**
 * Abstract Connection for Hosting Based Interfacing
 */
class AbstractHBIC extends EventEmitter {

  static createServer() {
    throw new Error('HBIC subclass [' + this.name + '] did not override static createServer!')
  }

  static handleWireErr(peer, transport, err, ...args) {
    if (!peer.emit(CONSTS.WIRE_ERR_EVENT, err, transport, ...args)) {
      console.error(err)
      throw err
    }
    peer.disconnect(null, 0, transport)
  }

  static handleLandingErr(peer, transport, err, code) {
    // try emit as local landing err
    if (peer.emit(CONSTS.LANDING_ERR_EVENT, err, code, transport)) {
      // landing errors are locally listened, and
      if (!peer.connected) {
        // local listener(s) disconnected wire
        return false
      } else {
        // assume local listener(s) handled this error without necessarity to disconnect
        // allow futher packets to be landed
        return true
      }
    } else {
      // landing error not listened, by default, disconnect forcefully after last attempt to send peer error
      peer.disconnect(err, CONSTS.DEFAULT_DISCONNECT_WAIT, transport)
      // and announce the error loudly
      console.error(err)
      throw err
    }
  }

  constructor(context, addr, {sendOnly=false, autoConnect = false, reconnDelay = 10000, netOpts}={}) {
    super()

    if ('object' !== typeof context)
      throw new Error('must supply an object as context')
    this.context = context

    this.addr = addr
    this.sendOnly = sendOnly
    if (autoConnect) {
      const reconn = ()=> {
        if (!this.addr) {
          // destroyed, stop reconnecting
          return
        }
        this._connect(()=> {
          // reconnect successful
          this.emit(CONSTS.WIRE_CONN_EVENT, this)
        }, (err)=> {
          // reconnect failed
          if (!this.emit(CONSTS.CONN_ERR_EVENT, err, this)) {
            console.error(err)
          }
          setTimeout(reconn, reconnDelay)
        })
      }
      this.on(CONSTS.WIRE_CLOSE_EVENT, ()=> {
        setTimeout(reconn, reconnDelay)
      })
      process.nextTick(reconn)
    }
    this.netOpts = netOpts
    this.connWaiters = []
    this.transport = null
  }

  handlePeerErr(message, stack) {
    var err = new Error(message)
    err.stack = ' * from * hbi * peer * ' + this.netInfo + ' * \n' + stack
    if (!this.emit(CONSTS.PEER_ERR_EVENT, err)) {
      console.error(err)
      throw err
    }
  }

  sendPeerError(err, cb) {
    if (!(err instanceof Error)) {
      err = new Error(err)
    }
    return this.sendWire(`handlePeerErr(${JSON.stringify(err.message)},${JSON.stringify(err.stack)})`, cb)
  }

  get netInfo() {
    if (!this.addr) {
      return '<destroyed>'
    }
    var transport = this.transport
    if (!transport) return '<unwired>'
    return '[hbic wired to ' + transport + ']'
  }

  get connected() {
    var transport = this.transport
    if (!transport) return false
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override connected getter!')
  }

  _connect(resolve, reject) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override _reconnect!')
  }

  connect() {
    if (this.connected) {
      return P.resolve(this)
    }
    this.disconnect() // make sure all resources for last transport are released
    return new P((resolve, reject)=> {
      this.connWaiters.push([resolve, reject])
      this._connect(()=> {
        let connWaiters = this.connWaiters
        if (connWaiters.length < 1) return
        this.connWaiters = []
        for (let [resolve,] of connWaiters) {
          resolve(this)
        }
      }, (err)=> {
        let connWaiters = this.connWaiters
        if (connWaiters.length < 1) return
        this.connWaiters = []
        for (let [,reject] of connWaiters) {
          reject(err)
        }
      })
    })
  }

  destroy() {
    this.addr = null
    this.netOpts = null

    this.disconnect()

    this.transport = null
  }

  _send(codeObj, cb, wireDir) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override _send!')
  }

  send(codeObj, cb) {
    return this._send(codeObj, cb)
  }

  sendWire(codeObj, cb) {
    return this._send(codeObj, cb, 'wire')
  }

  offloadData(sink) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override offloadData!')
  }

  resumeHosting(originalSink = null) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override resumeHosting!')
  }

  disconnect(errReason, destroyDelay = CONSTS.DEFAULT_DISCONNECT_WAIT, transport) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override disconnect!')
  }

}


module.exports = AbstractHBIC
