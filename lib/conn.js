'use strict';

const EventEmitter = require('events')
const P = require('bluebird')
const de = require('deep-equal')

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
    this.autoConnect = autoConnect
    this.reconnDelay = reconnDelay
    this.netOpts = netOpts
    this._connWaiters = []
    this._reconn = ()=> { // use arrow function or bound function for this
      if (!this.addr) {
        // destroyed or no addr provided yet, don't reconnect
        return
      }
      if (this._connecting) {
        // already trying connect
        return
      }
      this._connecting = true
      this._connect(()=> {
        // reconnect successful
        this._connecting = false

        // event listeners first
        this.emit(CONSTS.WIRE_CONN_EVENT, this)

        // promise waiters last
        let _connWaiters = this._connWaiters
        if (_connWaiters.length < 1) return
        this._connWaiters = []
        for (let [resolve,] of _connWaiters) {
          resolve(this)
        }
      }, (err)=> {
        // reconnect failed
        this._connecting = false

        // retry connect later if autoConnect
        if (this.autoConnect) {
          setTimeout(this._reconn, this.reconnDelay)
        }

        // event listeners first
        if (!this.emit(CONSTS.CONN_ERR_EVENT, err, this)) {
          console.error(err)
        }

        // promise waiters last
        let _connWaiters = this._connWaiters
        if (_connWaiters.length < 1) return
        this._connWaiters = []
        for (let [,reject] of _connWaiters) {
          reject(err)
        }
      })
    }
    this.on(CONSTS.WIRE_CLOSE_EVENT, ()=> {
      if (this.autoConnect) {
        setTimeout(this._reconn, this.reconnDelay)
      }
    })
    this.transport = null
    if (autoConnect) {
      this._reconn()
    }
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

  connect(addr, {netOpts}={}) {
    if (this.connected && (!addr || this.addr === addr)) {
      // already connected to same addr
      return P.resolve(this)
    }

    // make sure all resources for last transport are released
    this.disconnect()

    if (addr && !de(addr, this.addr)) {
      // connect to a different addr
      if (this._connWaiters.length > 0) {
        // with pending conn waiters, reject them
        let err = new Error('connecting attempt to [' + this.addr + '] overdue by [' + addr + ']')
        let _connWaiters = this._connWaiters
        this._connWaiters = []
        for (let [,reject] of _connWaiters) {
          reject(err)
        }
      }
      this.addr = addr
    }
    if (netOpts) {
      this.netOpts = netOpts
    }

    return new P((resolve, reject)=> {
      this._connWaiters.push([resolve, reject])
      this._reconn()
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
