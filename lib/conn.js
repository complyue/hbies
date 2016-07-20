'use strict';

const EventEmitter = require('events')
const P = require('bluebird')
const de = require('deep-equal')

const CONSTS = require('./constants')

const PromisingMutex = require('./pmutex')


var nextTick = process.nextTick
try {
  if (window !== navigator) {
    /*
     * browser env detected.
     *
     * browserify's process.nextTick simulation suffers the issue that succeeding ws data come before the function get
     * actually called. we need to invoke the function synchronously if not with process.nextTick from Node.js
     */
    nextTick = (fn, ...args)=> {
      fn.apply(null, args)
    }
  }
} catch (err) {
  // will reach here in Node.js, we are okay with this
}


/**
 * Abstract Connection for Hosting Based Interfacing
 */
class AbstractHBIC extends EventEmitter {


  static createServer() {
    throw new Error('HBIC subclass [' + this.name + '] did not override static createServer!')
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
    peer.disconnect(null, 0, transport)
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

  constructor(context, addr, {sendOnly = false, autoConnect = false, reconnDelay = 10000, netOpts}={}) {
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
    // since only one string is to be sent, no need to use _sendMutex for sequential order guarantee
    return this._send(
      `handlePeerErr(${JSON.stringify(err.message)},${JSON.stringify(err.stack)})`
      , null, 'wire').catch((err)=> {
      this.constructor.handleWireErr(this, err)
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

  _onceDrain(cb) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override _onceDrain!')
  }

  _sendText(codeObj, wireDir = '') {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override _send!')
  }

  _sendData(bufs) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override sendData!')
  }

  _sendGen(gen, resolve, reject, wireDir = '') {
    try {

      var [codeObj, done] = gen.next()
      if (done) {
        // always resolve to true since either the last write indicated so, or this func is triggered by drain event
        resolve(true)
        return
      }

      const nextGen = (sendMore)=> {
        const nextSend = ()=> {
          this._sendGen(gen, resolve, reject, wireDir)
        }
        if (sendMore) {
          process.nextTick(nextSend)
        } else {
          this._onceDrain(nextSend)
        }
      }

      if (codeObj && 'function' === typeof codeObj.next) {
        // sub generator/iterator yielded
        this._sendGen(codeObj, nextGen, reject, wireDir)
      } else {
        // assuming text
        this._sendText(codeObj, null, wireDir).then(nextGen)
      }

    } catch (err) {
      reject(err)
    }
  }

  _send(codeObj, bufs = null, wireDir = '') {
    if (!this.connected) {
      return P.reject(new Error('This HBIC is not wired!'))
    }

    var textSent

    if (codeObj && 'function' === typeof codeObj.next) {
      // it's a generator/iterator
      textSent = new P((resolve, reject)=> {
        this._sendGen(codeObj, resolve, reject, wireDir)
      })
    } else {
      // it's text code
      textSent = this._sendText(codeObj, wireDir)
    }

    if (bufs) {
      return textSent.then(()=> {
        this._sendData(bufs)
      })
    }

    return textSent
  }

  send(codeObj, bufs) {
    // neither binary data attached, nor codeObj is a generator/iterator, no need of the mutex
    if ((!bufs || bufs.length < 1) && (!codeObj || 'function' !== typeof codeObj.next)) {
      return this._send(codeObj)
    }

    // with binary attachment or to send a generator/iterator, use mutex to prevent interference
    return this._sendMutex.orderly(
      this._send(codeObj, bufs)
    )
  }

  sendData(bufs) {
    if (!bufs || bufs.length < 1)
      return P.resolve(true)

    // only one buffer to send, no need of the mutex
    if (bufs.length <= 1)
      return this._sendData(bufs)

    // multiple buffers to be sent, use mutex to prevent interference
    return this._sendMutex.orderly(
      this._sendData(bufs)
    )
  }

  offloadData(sink) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override offloadData!')
  }

  resumeHosting(readAhead, originalSink = null) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override resumeHosting!')
  }

  /**
   * Receive subsequent binary data from the wired transport into an arbitrary array hierarchy of buffers,
   * completion of each buffer or array triggers {@code cbComplete} with the current path of array indices.
   * when {@code cbComplete} is called with indices.length===0, all data have been received.
   *
   * The sum of byte lengths of all buffers, decides how much data to be received.
   *
   * @param bufferArrays arrays of ArrayBuffer/TypedArray/Buffer of any dimension greater than 1.
   * each element, if itself being an array, can even have different dimensions than its siblings, mix of arrays and
   * buffers is also allowed. Note a TypedArray is not considered an *array* here, so does JavaScript do.
   *
   * @param cbComplete (indices, arrayOrBuffer)
   *
   */
  receiveData(bufferArrays, cbComplete) {
    if (!bufferArrays || bufferArrays.length < 1) {
      return P.resolve(cbComplete([], bufferArrays))
    }

    return new P((resolve, reject)=> {
      // bootstrap
      var parentArrays = [bufferArrays]
      var indices = [-1]
      var buf = null, pos = 0

      // for every tick, process the real or dummy/empty chunk
      const dataSink = (chunk)=> {

        if (buf && pos < buf.length) {
          // current buffer not filled yet
          var src = this.constructor.mapBuffer(chunk)
          var consumed = this.constructor.copyBuffer(src, buf, pos)
          pos += consumed
          if (pos >= buf.length) {
            // current buffer filled
            cbComplete(indices, buf)
            buf = null
          } else {
            // chunk exhausted with a buffer not yet filled, expect succeeding real chunks to come, stop tick looping
            return
          }
          // even when the chunk is thoroughly consumed, if current buffer is filled, we still need to check finish
          // conditions, it's simpler to work out by leaving such checks for next tick
          return nextTick(dataSink, this.constructor.sliceBuffer(src, consumed))
        }

        // find new buf to fill
        var parentArray = parentArrays[parentArrays.length - 1]
        var currIndex = ++indices[indices.length - 1]

        // check if current array is finished
        if (currIndex >= parentArray.length) {
          indices.pop()
          parentArrays.pop()
          var cbResult = cbComplete(indices, parentArray)
          if (indices.length < 1) {
            // all finished
            resolve(cbResult)
            return this.resumeHosting(chunk, dataSink)
          }
          return nextTick(dataSink, chunk)
        }

        // next element in current array becomes current element
        var arrayOrBuffer = parentArray[currIndex]

        // check if current element is an array
        if (Array.isArray(arrayOrBuffer)) {
          if (arrayOrBuffer.length < 1) {
            // encountered an empty array, this is rare,
            // we don't optimize for it, just proceed current array in next tick
            return nextTick(dataSink, chunk)
          }
          // for this new array, go a level deeper
          parentArrays.push(arrayOrBuffer)
          indices.push(-1)
          if (!chunk || chunk.length < 1) {
            // enough finish check is done, if the chunk is empty, we can safely stop tick looping here
            return
          }
          return nextTick(dataSink, chunk)
        }

        // the element is a buffer, start filling it in next tick
        buf = this.constructor.mapBuffer(arrayOrBuffer)
        pos = 0
        return nextTick(dataSink, chunk)
      }

      this.offloadData(dataSink)
    })
  }

  disconnect(errReason, destroyDelay = CONSTS.DEFAULT_DISCONNECT_WAIT, transport) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override disconnect!')
  }

}


module.exports = AbstractHBIC
