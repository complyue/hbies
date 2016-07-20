'use strict';

const P = require('bluebird')

const CONSTS = require('./constants')

const ctx = require('./light-context')

// flow control
const HIGH_WATER_MARK = 12 * 1024 * 1024
const LOW_WATER_MARK = 8 * 1024 * 1024
const MIN_DELAY = 10
const MAX_DELAY = 60000

// max scanned length of packet header
const PACK_HEADER_MAX = 60
const PACK_BEGIN = '[#'
const PACK_END = ']'

const AbstractHBIC = require('./conn')

/**
 * Hosting Based Interfacing Connection
 *
 * this class runs in a browserified env with WebSocket transport
 */
class WSHBIC extends AbstractHBIC {


  static get ctx() {
    return ctx
  }

  static mapBuffer(buffer) {
    if (!buffer) return new Uint8Array(0)
    if (buffer instanceof Uint8Array)
      return buffer
    if (buffer instanceof ArrayBuffer)
      return new Uint8Array(buffer)
    var ab = buffer.buffer // in case is a typed array
    if (ab instanceof ArrayBuffer)
      return new Uint8Array(ab)
    throw new Error('Unsupported buffer of type [' + (typeof buffer) + '/'
      + (buffer.constructor && buffer.constructor.name) + ']')
  }

  static copyBuffer(src, tgt, pos) {
    var consumed = tgt.length - pos
    if (consumed < src.length) {
      src = src.subarray(0, consumed)
    } else if (consumed > src.length) {
      consumed = src.length
    }
    tgt.set(src, pos)
    return consumed
  }


  constructor(...args) {
    super(...args)

    this._dataSink = null
  }

  get netInfo() {
    var ws = this.transport
    if (!ws) return '<unwired>'
    switch (ws.readyState) {
      case 0:
        return '<connecting to:' + ws.url + '>'
      case 1:
        return '<connected to:' + ws.url + '>'
      case 2:
        return '<disconnecting from:' + ws.url + '>'
      case 3:
        return '<disconnected from:' + ws.url + '>'
      default:
        return '<ws to:' + ws.url + '>'
    }
  }

  get connected() {
    var ws = this.transport
    if (!ws) return false
    if (1 === ws.readyState || 0 === ws.readyState) return true
    return false
  }

  _connect(resolve, reject) {
    var url = this.addr
    if ('string' !== typeof url) {
      let protocol = url.protocol || 'ws'
      let host = url.host
      let port = url.port ? (':' + url.port) : ''
      let path = url.path || ''
      url = protocol + '://' + host + port + path
    }
    var ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    ws.onopen = (evt)=> {
      this.wire(ws)
      resolve()
    }
    ws.onerror = (evt)=> {
      reject(new Error('ws error before connected to [' + url + ']'))
    }
    ws.onclose = (evt)=> {
      reject(new Error('ws closed before connected to [' + url + ']'))
    }
  }

  _onceDrain(cb) {
    var ws = this.transport
    const checkDrain = ()=> {
      if (ws.bufferedAmount <= LOW_WATER_MARK) {
        cb()
        return
      }

      var delay = Math.round((ws.bufferedAmount - LOW_WATER_MARK) / 1024)
      if (delay < MIN_DELAY)
        delay = MIN_DELAY
      if (delay > MAX_DELAY)
        delay = MAX_DELAY
      setTimeout(checkDrain, delay)
    }
    checkDrain()
  }

  _sendText(codeObj, wireDir = '') {
    return new P((resolve, reject)=> {
      try {
        var ws = this.transport
        var payload
        if (!codeObj && codeObj !== false) {
          // sending nothing can be a means of keeping wire alive
          payload = ''
        } else {
          var jsonCode, jsonErr
          if (typeof(codeObj) === 'string') {
            jsonCode = codeObj
          } else {
            try {
              jsonCode = JSON.stringify(codeObj)
            } catch (err) {
              jsonErr = err.stack || err
            }
            if (!jsonCode) {
              throw new Error("HBI does not send code object of type [" + typeof(codeObj)
                + "] yet, which is not convertible to JSON. " + (jsonErr ? jsonErr : ''))
            }
          }
          payload = jsonCode
        }
        ws.send(PACK_BEGIN + wireDir + PACK_END + payload)
        resolve(ws.bufferedAmount < HIGH_WATER_MARK)
      } catch (err) {
        reject(err)
      }
    })
  }

  _sendData(bufs) {
    if (!bufs || bufs.length < 1) {
      return P.resolve(true)
    }

    return new P((resolve, reject)=> {

      const ws = this.transport
      var pos = 0
      const sendNext = ()=> {
        // hold until drain
        if (ws.bufferedAmount > LOW_WATER_MARK) {
          this._onceDrain(sendNext)
          return
        }

        // burst to high water mark
        while (ws.bufferedAmount < HIGH_WATER_MARK) {
          var buf = bufs[pos]
          if (!(buf instanceof ArrayBuffer)) {
            if (buf.buffer instanceof ArrayBuffer) {
              buf = buf.buffer // cases for TypedArray(s)
            } else {
              reject(new Error('Unsupported binary object type [' + (typeof buf) + '/' + buf.constructor.name + ']'))
              return
            }
          }

          ws.send(buf)

          if (++pos >= bufs.length) {
            // no more to send
            resolve(ws.bufferedAmount < HIGH_WATER_MARK)
            return
          }
        }

        // wait until drain again
        this._onceDrain(sendNext)
      }
      sendNext()

    })
  }

  wire(ws) {
    if (this.transport) {
      throw new Error('This HBIC is already wired!')
    }
    this.transport = ws
    ws.onerror = (evt)=> {
      var err = new Error('error of ws to [' + ws.url + ']')
      if (!this.constructor.handleWireErr(this, err, ws))
        console.error(err)
    }
    ws.onclose = (evt)=> {
      if (ws === this.transport) {
        this.transport = null

        this.emit(CONSTS.WIRE_CLOSE_EVENT, ws)

      }
    }
    if (!this.sendOnly) {
      ws.onmessage = (evt)=> {
        switch (typeof evt.data) {
          case 'string':
            var payload = evt.data
            if (!payload.startsWith(PACK_BEGIN)) {
              return this.constructor.handleWireErr(this, new Error('HBI packet from [' + ws.url + '] malformed, invalid PACK_BEGIN: ' + payload.substr(0, PACK_BEGIN.length)), ws)
            }
            var pePos = payload.substr(0, PACK_HEADER_MAX).indexOf(PACK_END, PACK_BEGIN.length)
            if (!pePos) {
              return this.constructor.handleWireErr(this, new Error('HBI packet from [' + ws.url + '] malformed, no PACK_END found in header: ' + payload.substr(0, PACK_HEADER_MAX)), ws)
            }
            var wireDir = payload.substring(PACK_BEGIN.length, pePos)
            payload = payload.substr(pePos + PACK_END.length)

            if (!this.land(ws, payload, wireDir)) {
              // unrecoverable failure in landing code
              return
            }

            if (this._dataSink) {
              // data sink planted during packet landing, but nothing to do for a ws transport here
            }

            break
          default:

            if (!this._dataSink) {
              return this.constructor.handleWireErr(this, new Error('unexpected binary data'), ws)
            }
            this._dataSink(evt.data)

            break
        }
      }
    }
  }

  offloadData(sink) {
    if (this._dataSink) {
      throw new Error('HBI connection already in data offloading')
    }
    if ('function' !== typeof sink) {
      throw new Error('HBI sink to offload data must be a function accepting data chunks')
    }
    this._dataSink = sink
    // tease it with an empty chunk for possible zero-length data scenarios
    sink(new ArrayBuffer(0))
  }

  resumeHosting(readAhead, originalSink = null) {
    if (originalSink && this._dataSink !== originalSink) {
      throw new Error('unpaired offloadData/resumeHosting call')
    }
    this._dataSink = null
    if (readAhead) {
      if ((readAhead.length || readAhead ) > 0) {
        throw new Error('ws with readahead')
      }
    }
  }

  _destroyWire(ws) {
    if (!ws) {
      return
    }
    if (1 === ws.readyState || 0 === ws.readyState) {
      ws.close(WebSocket.CLOSE_NORMAL)
    }
    if (ws === this.transport) {
      this.transport = null
    }
  }

  disconnect(errReason, destroyDelay = CONSTS.DEFAULT_DISCONNECT_WAIT, transport = null) {
    var ws = transport || this.transport
    if (!ws) {
      return
    }
    if (1 !== ws.readyState) {
      if (ws === this.transport) {
        this.transport = null
      }
      return
    }
    // ignore subsequent ws data
    ws.onmessage = null
    if (errReason) {
      var cbDestroy = ()=> {
        this._destroyWire(ws)
      }
      // timed unwire
      setTimeout(cbDestroy, destroyDelay)
      // meanwhile make reasonable effort to send the errReason as last packet
      try {
        // this races with the timed unwire
        this.sendPeerError(errReason)
        if (ws === this.transport) {
          this.transport = null
        }
      } catch (err) {
        console.error(err)
      }
    } else {
      this._destroyWire(ws)
    }
  }

}


module.exports = WSHBIC
