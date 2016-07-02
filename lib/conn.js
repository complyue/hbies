'use strict';

const EventEmitter = require('events')

const CONSTS = require('./constants')


/**
 * Abstract Connection for Hosting Based Interfacing
 */
class AbstractHBIC extends EventEmitter {

  static handleWireErr(peer, transport, err, ...args) {
    if (!peer.emit(CONSTS.WIRE_ERR_EVENT, err, transport, ...args)) {
      console.error(err)
      throw err
    }
    peer.disconnect(null, 0, transport)
  }

  static handleLandingErr(peer, transport, err, ...args) {
    // try emit as local landing err
    if (peer.emit(CONSTS.LANDING_ERR_EVENT, err, transport, ...args)) {
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

  handlePeerErr(message, stack) {
    var err = new Error(message)
    err.stack = ' * from * hbi * peer * ' + this.netInfo + ' * \n' + stack
    if (!this.emit(CONSTS.PEER_ERR_EVENT, err)) {
      console.error(err)
      throw err
    }
  }

  static sendPeerError(peer, err, cb) {
    if (!(err instanceof Error)) {
      err = new Error(err)
    }
    return peer.sendWire(`handlePeerErr(${JSON.stringify(err.message)},${JSON.stringify(err.stack)})`, cb)
  }

  constructor(context) {
    super()

    if ('object' !== typeof context)
      throw new Error('must supply an object as context')
    this.context = context

    this.transport = null
  }

  get netInfo() {
    var transport = this.transport
    if (!transport) return '<unwired>'
    return '[hbic wired to ' + transport + ']'
  }

  send(codeObj, cb) {
    return this._send(codeObj, cb)
  }

  sendWire(codeObj, cb) {
    return this._send(codeObj, cb, 'wire')
  }

  _send(codeObj, cb, wireDir) {
    var transport = this.transport
    if (!transport)
      throw new Error('This HBIC is not wired!')
    throw new Error('HBIC subclass [' + peer.constructor.name + '] failed to override _send!')
  }

  disconnect(errReason, destroyDelay = CONSTS.DEFAULT_DISCONNECT_WAIT, transport) {
    throw new Error('HBIC subclass [' + peer.constructor.name + '] failed to override disconnect!')
  }

  get connected() {
    var transport = this.transport
    if (!transport) return false
    throw new Error('HBIC subclass [' + peer.constructor.name + '] failed to override connected getter!')
  }
  
}


module.exports = AbstractHBIC
