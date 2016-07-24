'use strict';

const assert = require('assert')
const EventEmitter = require('events')
const P = require('bluebird')
const de = require('deep-equal')

const CONSTS = require('./constants')

const PromisingMutex = require('./pmutex')


/**
 * Abstract Connection for Hosting Based Interfacing
 */
class AbstractHBIC extends EventEmitter {


  static createServer() {
    throw new Error('HBIC subclass [' + this.name + '] did not override static createServer!')
  }

  static isBuffer(obj) {
    throw new Error('HBIC subclass [' + this.name + '] did not override static isBuffer!')
  }

  /**
   * Map raw data chunk to a performant buffer.
   *
   * The returned object must provide a {@code length} property which returns byte length of its capacity. Currently
   * {@code Buffer} as for Node.js and {@code Uint8Array) as for es6 env automatically satisfies this requirement
   *
   * @param chunk raw data chunk provided by underlying transport for data received
   */
  static mapBuffer(chunk) {
    throw new Error('HBIC subclass [' + this.name + '] did not override static mapBuffer!')
  }

  /**
   * Copy data between 2 buffers in performant manner
   *
   * @param src from this buffer
   * @param tgt to this buffer
   * @param pos offset from {@code tgt}
   *
   * @return bytes copied, should {@code min( tgt.length - pos, src.length )}
   */
  static copyBuffer(src, tgt, pos) {
    throw new Error('HBIC subclass [' + this.name + '] did not override static copyBuffer!')
  }

  /**
   * Subclass should  override this if underlying implementation differs.
   *
   * So far Buffer of Node.js and Uint8Array of es6 can be sliced with same signature.
   *
   * @param buf the mapped buffer by {@code mapBuffer}
   *
   * @param begin byte offset
   *
   * @returns remaining data as a new buffer from {@code begin} position.
   * It should be a shallow copy as far as possible for performance
   */
  static sliceBuffer(buf, begin) {
    return buf.slice(begin)
  }


  static handleWireErr(peer, err, transport, ...args) {
    if (!peer.emit(CONSTS.WIRE_ERR_EVENT, err, transport, ...args)) {
      console.error(err)
      throw err
    }
    peer.disconnect(err, 0, transport)
    return false
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

  constructor(context, addr, {
    sendOnly = false, autoConnect = false, reconnDelay = 10000, netOpts = {},
    lowWaterMarkerSend = 8 * 1024 * 1024, highWaterMarkSend = 12 * 1024 * 1024,
    lowWaterMarkerRecv = 8 * 1024 * 1024, highWaterMarkRecv = 12 * 1024 * 1024
  }={}) {
    super()

    if ('object' !== typeof context)
      throw new Error('must supply an object as context')
    this.context = context

    this.addr = addr
    this.sendOnly = sendOnly
    this.autoConnect = autoConnect
    this.reconnDelay = reconnDelay
    this.netOpts = netOpts
    this.lowWaterMarkerSend = lowWaterMarkerSend
    this.highWaterMarkSend = highWaterMarkSend
    this.lowWaterMarkerRecv = lowWaterMarkerRecv
    this.highWaterMarkRecv = highWaterMarkRecv

    this._drainWaiters = []
    this._checkDrain = ()=> {
      if (!this.connected) return
      var buffered = this._getBufferedAmount()
      if (buffered <= this.lowWaterMarkerSend) {
        // fall below lwm, trigger one drain waiter
        var waiter = this._drainWaiters.shift()
        waiter()
      } else {
        // at higher waiter position, need to check back later
        // delay 1 ms for each 12.5KB, roughly the theoretical 1G ether speed
        var delay = (buffered - this.lowWaterMarkerSend) / 12800
        if (delay > 60000) delay = 60000 // 1 minute max delay
        setTimeout(this._checkDrain, delay)
      }
    }

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
    this._sendMutex = new PromisingMutex()
  }

  handlePeerErr(message, stack) {
    var err = new Error(message)
    err.stack = ' * from * hbi * peer * ' + this.netInfo + ' * \n' + stack
    if (!this.emit(CONSTS.PEER_ERR_EVENT, err)) {
      console.error(err)
      throw err
    }
  }

  sendPeerError(err) {
    if (!(err instanceof Error)) {
      err = new Error(err)
    }
    return this.sendCode(
      `handlePeerErr(${JSON.stringify(err.message)},${JSON.stringify(err.stack)})`
      , 'wire'
    ).catch((err)=> {
      this.constructor.handleWireErr(this, err)
      // in this case the wire should have been destroyed, re-reject it anyway
      return P.reject(err)
    })
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

  land(transport, payload, wireDir) {
    if (wireDir) {
      // got wire affair packet, landing
      var wireErr
      try {
        if ('wire' === wireDir) {
          // affair on the wire itself
          this.constructor.ctx.runInContext(payload, this)
        } else {
          // no more affairs implemented yet
          wireErr = new Error('HBI packet header from [' + this.netInfo + '] malformed, invalid wire directive: ' + wireDir)
        }
      } catch (err) {
        wireErr = err
      }
      if (wireErr) {
        return this.constructor.handleWireErr(this, wireErr, transport)
      }
    } else {
      // got plain packet to be hosted, landing & treating
      var landingErr
      try {
        this.context.$peer$ = this
        this.constructor.ctx.runInContext(payload, this.context)
        this.context.$peer$ = null
        this.emit(CONSTS.PACKET_EVENT, payload)
      } catch (err) {
        landingErr = err
      }
      if (landingErr) {
        if (!this.constructor.handleLandingErr(this, transport, landingErr, payload)) {
          // not recoverable, assume wire destroyed by handlLandingErr
          return false
        }
      }
    }

    return true
  }


  _getBufferedAmount() {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override _getBufferedAmount!')
  }

  _onceDrain(cb) {
    this._drainWaiters.push(cb)
    this._checkDrain()
  }

  /**
   * Schedule a callback when outgoing through the wire is considered drain according to flow control.
   *
   * @param cb
   */
  _onceDrain(cb) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override _onceDrain!')
  }

  /**
   * Synchronously send out a code string or object that can be converted to JSON string.
   *
   * @param code string or binary data of the string
   * @param wireDir wire directive
   *
   * @returns whether the wire accepts more data according to flow control
   */
  _sendText(code, wireDir = '') {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override _sendText!')
  }

  /**
   * Synchronously send out a binary buffer.
   *
   * @param buf binary data
   *
   * @returns whether the wire accepts more data according to flow control
   */
  _sendBuffer(buf) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override _sendData!')
  }

  _promiseCodeSend(code, wireDir) {
    return (resolve, reject)=> {
      try {
        if ('string' === typeof code) {
          // fast track to send a single text code, no hierarchy traversal needed
          resolve(this._sendText(code, wireDir))
        } else if (code && 'function' === typeof code.next) {
          // it's a generator/iterator, use a generator to pull code out of hierarchy
          const puller = (function* pullFrom(container) {
            for (var coc of container) {
              if ('function' === typeof coc.next) {
                // nested generator/iterator
                yield* pullFrom(coc)
              } else {
                yield coc
              }
            }
          })(code)
          const sendMore = ()=> {
            while (true) {
              var nv = puller.next()
              if (nv.done) {
                resolve()
                return
              }
              if (!this._sendText(nv.value, wireDir)) {
                this._onceDrain(sendMore)
                return
              }
            }
          }
          sendMore()
        } else {
          // not to support other container objects like iterables. if needed, consider explicitly converting to
          // iterator or just use generators

          // last resort, convert to JSON, let errors pass through
          resolve(this._sendText(JSON.stringify(code), wireDir))
        }
      } catch (err) {
        reject(err)
      }
    }
  }

  _promiseDataSend(bufs) {
    return (resolve, reject)=> {
      // use a generator to pull buffers out of hierarchy
      const puller = (function* pullFrom(boc) {
        if (this.constructor.isBuffer(boc)) {
          yield boc
        } else {
          for (var boc1 of boc) {
            yield* pullFrom(boc1)
          }
        }
      })(bufs)
      const sendMore = ()=> {
        try {
          while (true) {
            var nv = puller.next()
            if (nv.done) {
              resolve()
              return
            }
            if (!this._sendBuffer(nv.value)) {
              this._onceDrain(sendMore)
              return
            }
          }
        } catch (err) {
          reject(err)
        }
      }
      sendMore()
    }
  }

  /**
   * Send a series of code objects as a consecutive sequence over the wire.
   *
   * @param code string/iterator of code/JSONable
   * @param wireDir wire directive
   *
   * @returns a promise resolved when the whole sequence is sent out and more data can be sent over the wire according
   * to flow control
   */
  sendCode(code, wireDir) {
    // use mutex to prevent interference
    return this._sendMutex.orderly(this._promiseCodeSend(code, wireDir))
  }

  /**
   * Send a series of binary data, as a consecutive sequence over the wire.
   *
   * @param bufs buffer/iterable of buffers/iterable of iterables of buffers
   *
   * @returns a promise resolved when the whole sequence is sent out and more data can be sent over the wire according
   * to flow control
   */
  sendData(bufs) {
    // use mutex to prevent interference
    return this._sendMutex.orderly(this._promiseDataSend(bufs))
  }

  /**
   * Send a series of code objects followed by binary data, as a consecutive sequence over the wire.
   *
   * @param code string/iterator of code/JSONable
   * @param bufs buffer/iterable of buffers/iterable of iterables of buffers
   *
   * @returns a promise resolved when the whole sequence is sent out and more data can be sent over the wire according
   * to flow control
   */
  send(code, bufs) {
    // use mutex to prevent interference
    return this._sendMutex.orderly((resolve, reject)=> {
      new P(this._promiseCodeSend(code)).then(()=>new P(this._promiseDataSend(bufs))).then(resolve, reject)
    })
  }


  offloadData(sink) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override offloadData!')
  }

  resumeHosting(readAhead, originalSink = null) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override resumeHosting!')
  }

  recvData(bufs) {
    // use a generator to pull all buffers from hierarchy
    const puller = (function* pullFrom(boc) {
      if (this.constructor.isBuffer(boc)) {
        yield boc
      } else {
        for (var boc1 of boc) {
          yield* pullFrom(boc1)
        }
      }
    })(bufs)

    return new P((resolve, reject)=> {
      var buf = null, pos = 0

      const dataSink = (chunk)=> {
        try {
          while (true) {
            if (buf) {
              assert(pos < buf.length)
              // current buffer not filled yet
              var src = this.constructor.mapBuffer(chunk)
              var consumed = this.constructor.copyBuffer(src, buf, pos)
              pos += consumed
              if (pos >= buf.length) {
                // current buffer filled, clear the pointer
                buf = null
                // continue to process rest data in chunk, even chunk is empty now, still need to proceed for
                // finish condition check
              } else {
                // this data chunk has been exhausted with a buffer not yet filled, return now and expect
                // succeeding data chunks to come later
                return
              }
            }

            // pull next buf to fill
            try {
              var nb = puller.next()
            } catch (err) {
              var usageErr = new Error('buffer source produced error: ' + err.message || err)
              usageErr.cause = err
              throw usageErr
            }
            if (nb.done) {
              // all buffers in hierarchy filled, finish receiving
              this.resumeHosting(chunk, dataSink)
              // resolve the promise
              resolve(bufs)
              // and done
              return
            }
            // got next buf
            buf = nb.value
          }
        } catch (err) {
          this.constructor.handleWireErr(err)
          reject(err)
        }
      }

      this.offloadData(dataSink)
    })
  }

  disconnect(errReason, destroyDelay = CONSTS.DEFAULT_DISCONNECT_WAIT, transport) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override disconnect!')
  }

}


module.exports = AbstractHBIC
