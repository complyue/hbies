'use strict';

const assert = require('assert')
const EventEmitter = require('events')
const P = require('bluebird')
const de = require('deep-equal')

const CONSTS = require('./constants')

const BufferList = require('./buflist')
const ObjectList = require('./objlist')


/**
 * Abstract Connection for Hosting Based Interfacing
 */
class AbstractHBIC extends EventEmitter {


  static createServer() {
    throw new Error('HBIC subclass [' + this.name + '] did not override static createServer!')
  }

  /**
   * Run a generator and return a Promise for its result.
   *
   * All objects with a callable `then` is treated as Promises.
   *
   * All objects with callable `next` and `throw` is treated as nested generator for coroutine.
   *
   * @param g a generator
   */
  static promise(g) {
    if (!g || 'function' !== typeof g.next || 'function' !== typeof g.throw) {
      throw new Error('one generator is expected')
    }

    return new P((resolve, reject)=> {

      // this function drives the generator stepping forward
      const itrun = (awv)=> {
        while (true) {

          if (awv) {

            // a promise as the awaited value, chain to its resolution
            if ('function' === typeof awv.then) {
              awv.then((rv)=> {
                setImmediate(itrun, rv)
              }, (err)=> {
                // if the awaited promise rejects, propagate the err to generator
                try {
                  var itr = g.throw(err)
                  // to here, the generator handled the err
                  if (itr.done) {
                    // the generator returned, resolve and all done
                    resolve(itr.value)
                  } else {
                    // the generator continued, step it later
                    setImmediate(itrun, itr.value)
                  }
                } catch (gerr) {
                  // the generator threw, reject and all done
                  reject(gerr)
                }
              })
              return
            }

            // a nested generator as the awaited value, chain a stackless execution as currently implemented
            // consider adding stack information in the future
            if ('function' === typeof awv.next && 'function' === typeof awv.throw) {
              this.promise(awv).then((rv)=> {
                setImmediate(itrun, rv)
              }, (err)=> {
                // if the awaited promise rejects, propagate the err to generator
                try {
                  var itr = g.throw(err)
                  // to here, the generator handled the err
                  if (itr.done) {
                    // the generator returned, resolve and all done
                    resolve(itr.value)
                  } else {
                    // the generator continued, step it later
                    setImmediate(itrun, itr.value)
                  }
                } catch (gerr) {
                  // the generator threw, reject and all done
                  reject(gerr)
                }
              })
              return
            }

          }

          // step the generator with the value it's awaiting
          try {
            var itr = g.next(awv)
          } catch (err) {
            // the generator threw, reject and all done
            reject(err)
            return
          }

          if (itr.done) {
            // generator returned, resolve and all done
            resolve(itr.value)
            return
          }

          // step the generator further with new value
          awv = itr.value
        }
      }

      // synchronously start the generator
      itrun(undefined)
    })
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


  constructor(context, addr, {
    sendOnly = false, autoConnect = false, reconnDelay = 10000, netOpts = {},
    lowWaterMarkSend = 2 * 1024 * 1024, highWaterMarkSend = 12 * 1024 * 1024,
    lowWaterMarkRecv = 2 * 1024 * 1024, highWaterMarkRecv = 12 * 1024 * 1024
  }={}) {
    super()

    if ('object' !== typeof context)
      throw new Error('must supply an object as context')
    this.context = context
    this.transport = null

    this.addr = addr
    this.sendOnly = sendOnly
    this.autoConnect = autoConnect
    this.reconnDelay = reconnDelay
    this.netOpts = netOpts

    this.lowWaterMarkSend = lowWaterMarkSend
    this.highWaterMarkSend = highWaterMarkSend
    this._sending = false
    this._sendWaiters = new ObjectList()
    const _leaveSending = ()=> {
      assert(this._sending, 'not in sending while leave')
      var waiter = this._sendWaiters.shift()
      if (waiter) {
        // resolve next waiter
        waiter[0]()
      } else {
        this._sending = false
      }
    }
    this._sendMutex = ()=> {
      if (this._sending) {
        // in sending, schedule for waiting
        return new P((resolve, reject)=> {
          this._sendWaiters.push([resolve, reject])
        }).disposer(_leaveSending)
      }

      // not in sending, enter right now
      this._sending = true
      return P.resolve().disposer(_leaveSending)
    }
    this._drainWaiters = new ObjectList()
    this._checkDrain = ()=> {
      if (!this.connected) return
      var buffered = this._getBufferedAmount()
      if (buffered <= this.lowWaterMarkSend) {
        // fall below lwm, trigger one drain waiter
        var waiter = this._drainWaiters.shift()
        if (waiter) {
          waiter()
        }
      } else {
        // at higher waiter position, need to check back later
        // delay 1 ms for each 12.5KB, roughly the theoretical 1G ether speed
        var delay = (buffered - this.lowWaterMarkSend) / 12800
        if (delay > 60000) delay = 60000 // 1 minute max delay
        setTimeout(this._checkDrain, delay)
      }
    }

    this._buffer = new BufferList()
    this._dataSink = null
    this.lowWaterMarkRecv = lowWaterMarkRecv
    this.highWaterMarkRecv = highWaterMarkRecv
    this._recvObjWaiters = new ObjectList()

    this._corunning = false
    this._coTaskQueue = new ObjectList()
    const _leaveCoRun = ()=> {
      assert(this._corunning, 'not in corun mode while leave')
      var nextCo = this._coTaskQueue.unshift()
      if (nextCo) {
        // got next coro to run
        var [g,resolve,reject] = nextCo
        P.using(P.resolve().disposer(_leaveCoRun), ()=>
          this.constructor.promise(g).then(resolve, reject)
        )
      } else {
        // no more coro to run, switch back to hosting mode
        this._corunning = false
        this._readWire()
      }
    }
    this._corunMutex = ()=> {
      if (this._corunning) {
        // have other coroutine running in progress, queue it for later execution
        return new P((resolve, reject)=> {
          this._coTaskQueue.push([g, resolve, reject])
        }).disposer(_leaveCoRun)
      }

      // in hosting mode, can start corun immediately
      this._corunning = true
      this._readWire()
      return P.resolve().disposer(_leaveCoRun)
    }

    this._connWaiters = new ObjectList()
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
        for (let [resolve,] of this._connWaiters.drain()) {
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
        for (let [,reject] of this._connWaiters.drain()) {
          reject(err)
        }
      })
    }
    this.on(CONSTS.WIRE_CLOSE_EVENT, ()=> {
      if (this.autoConnect) {
        setTimeout(this._reconn, this.reconnDelay)
      }
    })
    if (autoConnect) {
      this._reconn()
    }
  }

  get sending() {
    return this._sending
  }

  get rorunning() {
    return this._corunning
  }

  handleWireErr(err, transport, ...args) {
    if (!this.emit(CONSTS.WIRE_ERR_EVENT, err, transport, ...args)) {
      console.error(err)
      throw err
    }
    this.disconnect(null, 0, transport)
    return false
  }

  handleLandingErr(err, code) {
    // try emit as local landing err
    if (this.emit(CONSTS.LANDING_ERR_EVENT, err, code)) {
      // landing errors are locally listened, and
      if (!this.connected) {
        // local listener(s) disconnected wire
        return false
      } else {
        // assume local listener(s) handled this error without necessarity to disconnect
        // allow futher packets to be landed
        return true
      }
    } else {
      // landing error not listened, by default, disconnect forcefully after last attempt to send peer error
      this.disconnect(err, CONSTS.DEFAULT_DISCONNECT_WAIT)
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

  sendPeerError(err) {
    if (!(err instanceof Error)) {
      err = new Error(err)
    }
    // use mutex to prevent interference
    return P.using(this._sendMutex(), ()=>new P(this._sendCodeTask(
      `handlePeerErr(${JSON.stringify(err.message)},${JSON.stringify(err.stack)})`
      , 'wire'
    ))).catch((err)=> {
      this.handleWireErr(err)
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
    if (this.connected && (!addr || de(addr, this.addr))) {
      // already connected to same addr
      return P.resolve(this)
    }

    // make sure all resources for last transport are released
    this.disconnect()

    // need to establish new transport, use mutexes to assure existing works finished
    return P.using(this._sendMutex(), this._corunMutex(), ()=> {

      if (addr && !de(addr, this.addr)) {
        // connect to a different addr
        if (this._connWaiters.length > 0) {
          // with pending conn waiters, reject them
          let err = new Error('connecting attempt to [' + this.addr + '] overdue by [' + addr + ']')
          for (let [,reject] of this._connWaiters.drain()) {
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

    })
  }

  destroy() {
    this.addr = null
    this.netOpts = null

    this.disconnect()

    this.transport = null
  }

  land(payload, wireDir) {
    if (wireDir) {
      // got wire affair packet, landing
      var wireErr
      try {
        if ('wire' === wireDir) {
          // affair on the wire itself
          var rv = this.constructor.ctx.runInContext(payload, this)
        } else if ('corun' === wireDir) {
          this.context.$peer$ = this
          var g = this.constructor.ctx.runInContext(payload, this.context)
          this.context.$peer$ = null
          var rv = this.corun(g)
          return [null, rv]
        } else {
          // no more affairs implemented yet
          wireErr = new Error('HBI packet header from [' + this.netInfo + '] malformed, invalid wire directive: ' + wireDir)
        }
      } catch (err) {
        wireErr = err
      }
      if (wireErr) {
        if (this.handleWireErr(wireErr)) {
          // recovered
          return [undefined]
        } else {
          // not recovered
          return undefined
        }
      }
    } else {
      // got plain packet to be hosted, landing & return
      try {
        this.context.$peer$ = this
        var rv = this.constructor.ctx.runInContext(payload, this.context)
        this.context.$peer$ = null
        this.emit(CONSTS.PACKET_EVENT, payload)
        return [null, rv]
      } catch (err) {
        // try handle the error by listeners
        this.handleLandingErr(err, payload)
        // return the err so the running coro also has a chance to handle it
        return [err]
      }
    }

    return undefined
  }


  /**
   * Schedule a callback when outgoing through the wire is considered drain according to flow control.
   *
   * @param cb
   */
  _onceDrain(cb) {
    this._drainWaiters.push(cb)
    this._checkDrain()
  }

  /**
   * @returns the amount of data currently cached for sending, in bytes
   */
  _getBufferedAmount() {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override _getBufferedAmount!')
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

  _sendCodeTask(code, wireDir) {
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
                resolve(true)
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

          // last resort, convert to literal, let errors pass through
          var codeLit = CONSTS.lit`${code}`
          resolve(this._sendText(codeLit, wireDir))
        }
      } catch (err) {
        reject(err)
      }
    }
  }

  _sendDataTask(bufs) {
    if (!bufs) {
      throw new Error('sending null data')
    }
    return (resolve, reject)=> {
      // use a generator to pull buffers out of hierarchy
      const puller = (function* pullFrom(boc) {
        var buf = this.constructor.mapBuffer(boc)
        if (buf !== null && buf !== undefined) {
          yield buf
        } else {
          for (var boc1 of boc) {
            yield* pullFrom.call(this, boc1)
          }
        }
      }).call(this, bufs)
      const sendMore = ()=> {
        try {
          while (true) {
            var nv = puller.next()
            if (nv.done) {
              resolve(true)
              return
            }
            var buf = nv.value
            if (!this._sendBuffer(buf)) {
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
   * Send a series of code objects from a corun generator.
   *
   * @param code string/iterator of code/JSONable
   * @param wireDir wire directive
   *
   * @returns a promise resolved when the whole sequence is sent out and more data can be sent over the wire according
   * to flow control
   */
  coSendCode(code) {
    if (!this._corunning) {
      throw new Error('not in corun mode')
    }
    return new P(this._sendCodeTask(code))
  }

  /**
   * Send a series of binary data, from a corun generator.
   *
   * @param bufs buffer/iterable of buffers/iterable of iterables of buffers
   *
   * @returns a promise resolved when the whole sequence is sent out and more data can be sent over the wire according
   * to flow control
   */
  coSendData(bufs) {
    if (!this._corunning) {
      throw new Error('not in corun mode')
    }
    return new P(this._sendDataTask(bufs))
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
  sendCode(code) {
    if (this._corunning) {
      throw new Error('this should only be used in hosting mode')
    }
    // use mutex to prevent interference
    return P.using(this._sendMutex(), ()=>new P(this._sendCodeTask(code)))
  }

  /**
   * Send a series of binary data, as a consecutive sequence over the wire.
   *
   * Caution: There is no guarantee what'll be sent before or after the sent data, since concurrent sending over
   * this hbic is possible and this method only prevent other traffic from getting into mid of the data stream drawn
   * from bufs. Thus this method is only safe when peer already in active binary receiving state, and knows the size
   * and format of the payload.
   *
   * @param bufs buffer/iterable of buffers/iterable of iterables of buffers
   *
   * @returns a promise resolved when the whole sequence is sent out and more data can be sent over the wire according
   * to flow control
   */
  sendData(bufs) {
    if (this._corunning) {
      throw new Error('this should only be used in hosting mode')
    }
    // use mutex to prevent interference
    return P.using(this._sendMutex(), ()=>new P(this._sendDataTask(bufs)))
  }

  /**
   * Send a series of code objects followed by binary data, as a consecutive sequence over the wire.
   *
   * The code series should trigger peer to start and finish receiving the following binary data in correct format.
   *
   * @param code string/iterator of code/JSONable
   * @param bufs buffer/iterable of buffers/iterable of iterables of buffers
   *
   * @returns a promise resolved when the whole sequence is sent out and more data can be sent over the wire according
   * to flow control
   */
  convey(code, bufs) {
    if (this._corunning) {
      throw new Error('this should only be used in hosting mode')
    }

    // use mutex to prevent interference
    return P.using(this._sendMutex(), ()=> {
      return new P(this._sendCodeTask(code)).then(()=>new P(this._sendDataTask(bufs)))
    })
  }

  /**
   * Receive binary data from the wire to a series of buffers.
   *
   * The buffers can be yielded from a generator. The resulting promise can be yielded by a corun generator to await
   * for all buffers get filled.
   *
   * @param bufs single buffer/iterable of buffers/iterable of iterables of buffers
   *
   * @returns a promise resolved when no buffer left unfilled
   *
   */
  _recvData(bufs) {
    // use a generator to pull all buffers from hierarchy
    const puller = (function* pullFrom(boc) {
      var buf = this.constructor.mapBuffer(boc)
      if (buf !== null && buf !== undefined) {
        yield buf
      } else {
        for (var boc1 of boc) {
          yield* pullFrom.call(this, boc1)
        }
      }
    }).call(this, bufs)

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
                chunk = chunk.slice(consumed)
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
              err.message = 'buffer source produced error: ' + err.message
              throw err
            }
            if (nb.done) {
              // all buffers in hierarchy filled, finish receiving
              this._endOffload(chunk, dataSink)
              // resolve the promise
              resolve(bufs)
              // and done
              return
            }
            // got next buf
            buf = nb.value
            pos = 0
          }
        } catch (err) {
          this.handleWireErr(err)
          reject(err)
        }
      }

      this._beginOffload(dataSink)
    })
  }

  /**
   * Receive binary data from the wire to a series of buffers. This must be called from a corun generator.
   *
   * The buffers can be yielded from a generator. The resulting promise can be yielded by the corun generator to await
   * for all buffers get filled.
   *
   * @param bufs single buffer/iterable of buffers/iterable of iterables of buffers
   *
   * @returns a promise resolved when no buffer left unfilled
   *
   */
  coRecvData(bufs) {
    if (!this._corunning) {
      throw new Error('not in corun mode')
    }
    return this._recvData(bufs)
  }

  /**
   * Receive binary data from the wire to a series of buffers. This must not be called from a corun generator.
   *
   * The buffers can be yielded from a generator.
   *
   * @param bufs single buffer/iterable of buffers/iterable of iterables of buffers
   *
   * @returns a promise resolved when no buffer left unfilled
   *
   */
  recvData(bufs) {
    if (this._corunning) {
      throw new Error('this should only be used in hosting mode')
    }
    return this._recvData(bufs)
  }

  /**
   * Receive an object from wire. This must be called from a corun generator.
   *
   * The resulting promise can be yielded by the corun generator to await for an object is available.
   */
  coRecvObj() {
    while (true) {
      if (!this._corunning) {
        throw new Error('not in corun mode')
      }
      // continue poll one obj from buffer
      var got = this._landOne()
      if (got) {
        if (this._recvObjWaiters.length > 0) {
          // resolve previous waiters first
          var objWaiter = this._recvObjWaiters.shift()
          if (got[0]) {
            // reject
            objWaiter[1](got[0])
          } else {
            // resolve
            objWaiter[0](got[1])
          }
          continue
        }

        // all waiters resolved and got one, return it as settled
        if (got[0]) {
          return P.reject(got[0])
        }
        return P.resolve(got[1])
      }

      // no object from buffer available now, queue as a waiter, return the wrapping promise
      return new P((resolve, reject)=> {
        this._recvObjWaiters.push([resolve, reject])
        this._readWire()
      })
    }
  }

  _beginOffload(sink) {
    if (this._dataSink) {
      throw new Error('HBI connection already in data offloading')
    }
    if ('function' !== typeof sink) {
      throw new Error('HBI sink to offload data must be a function accepting data chunks')
    }
    this._dataSink = sink
    if (this._buffer.length > 0) {
      // having buffered data, dump to sink
      // note the sink may get enough data with only parts of buffered chunks,
      // this is signaled by this._dataSink cleared to null
      do {
        var buf = this._buffer.shift()
        sink(buf) // mangics can happen inside this call
      } while (this._dataSink === sink)
    } else {
      // no buffered data, but tease the sink with an empty chunk for possible zero-length data scenarios
      sink(Buffer.alloc(0))
    }
  }

  _endOffload(readAhead, originalSink = null) {
    if (originalSink && this._dataSink !== originalSink) {
      throw new Error('unpaired offloadData/resumeHosting call')
    }
    this._dataSink = null
    if (readAhead) {
      // prepend to buffer
      this._buffer.unshift(readAhead)
      // this should have been called from a receiving loop or coroutine, so return here should allow either continue
      // processing the recv buffer, or the coroutine proceed
    }
  }

  _readWire() {
    while (true) {
      // feed as much buffered data as possible to data sink if present
      while (this._dataSink) {
        var chunk = this._buffer.shift()
        if (!chunk) {
          // no more buffered data, wire is empty, return
          return
        }
        this._dataSink(chunk)
      }

      // in hosting mode, make the incoming data flew as fast as possible
      if (!this._corunning) {
        // try consume all buffered data first
        while (true) {
          var got = this._landOne()
          if (!got) {
            // no more packets to land
            break
          }
          if (this._corunning) {
            // switched to corun mode during landing, stop draining wire, let the coro recv on-demand,
            // and let subsequent incoming data to trigger hwm back pressure
            return
          }
        }
        // and make sure the receiving on wire is not paused
        this._resumeRecv()
        return
      }

      // currently in corun mode
      // first, try landing as many packets as awaited from buffered data
      while (this._recvObjWaiters.length > 0) {
        var objWaiter = this._recvObjWaiters.shift()
        var got = this._landOne()
        if (!got) {
          // no obj available from buffer for now
          this._recvObjWaiters.unshift(objWaiter)
          break
        }
        if (got[0]) {
          // reject
          objWaiter[1](got[0])
        } else {
          // resolve
          objWaiter[0](got[1])
        }
        if (!this._corunning) {
          // switched to hosting mode during landing, just settled waiter should be the last one being awaited
          assert(this._recvObjWaiters.length <= 0, 'recv waiters remained after coro terminated ?!')
          break
        }
      }

      // and if still in corun mode, i.e. not finally switched to hosting mode by previous landings
      if (this._corunning) {
        // flow ctrl regarding buffered amount
        var bufferedAmount = this._getBufferedAmount()
        if (bufferedAmount > this.highWaterMarkRecv) {
          this._pauseRecv()
        } else if (bufferedAmount <= this.lowWaterMarkRecv) {
          this._resumeRecv()
        }
        // return now and will be called on subsequent recv demand
        return
      }
    }
  }

  _pauseRecv() {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override _pauseRecv!')
  }

  _resumeRecv() {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override _resumeRecv!')
  }

  _landOne() {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override _landOne!')
  }

  /**
   * Run a generator as a coroutine.
   *
   * After a coroutine is launched by this HBIC, it switches itself into `corun` mode. In contrast to normal `hosting`
   * mode, packets will not get landed immediately at arrival, thus the binary data. The wire will pause receiving when
   * `highWaterMark` has been reached by the underlying buffer. The generator is expected to read packet landing results
   * and binary data through `coRecvObj` and `coRecvData` by yielding the result promises of these method calls, the
   * settled result - either value sent back to the yield statement or exception thrown from it - is available to the
   * generator function, thus make it in fact `coroutine`.
   *
   * @param g a generator
   */
  corun(g) {
    if (!g || 'function' !== typeof g.next || 'function' !== typeof g.throw) {
      throw new Error('generator is expected to run as coroutine')
    }

    // the coro must run with sending and corunning mutex locked, to prevent interference with other sendings or coros
    return P.using(this._sendMutex(), this._corunMutex(), ()=>
      this.constructor.promise(g)
    )

  }

  sendCoRun(code, bufs = null) {
    const job = ()=> {
      var codeP = new P(this._sendCodeTask(code, 'corun'))
      if (bufs)
        return codeP.then(()=>new P(this._sendDataTask(bufs)))
      return codeP
    }
    if (this._corunning) {
      // sending mutex is effectively locked in corun mode
      return job()
    } else {
      // use mutex to prevent interference
      return P.using(this._sendMutex(), job)
    }
  }

  cancelPendingCoTasks(err) {
    if (this._coTaskQueue.length < 1)
      return

    if (!err) {
      err = new Error('canceled')
    }

    // call reject handler
    for (var [g,resolve,reject] of this._coTaskQueue.drain()) {
      rejectc(err)
    }
  }


  disconnect(errReason, destroyDelay = CONSTS.DEFAULT_DISCONNECT_WAIT, transport) {
    throw new Error('HBIC subclass [' + this.constructor.name + '] did not override disconnect!')
  }

}


module.exports = AbstractHBIC
