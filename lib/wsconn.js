'use strict';

const CONSTS = require('./constants')

const ctx = require('./light-context')

// ideal amount of data kept in the ws buffer
const OPTIMAL_BUF_AMOUNT = 10240
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
    var ws = new WebSocket(this.addr)
    ws.onopen = (evt)=> {
      this.wire(ws)
      resolve()
    }
    ws.onerror = (evt)=> {
      reject(new Error('ws error before connected to [' + this.addr + ']'))
    }
    ws.onclose = (evt)=> {
      reject(new Error('ws closed before connected to [' + this.addr + ']'))
    }
  }

  _send(codeObj, cb, wireDir = '') {
    var ws = this.transport
    if (!ws)
      throw new Error('This HBIC is not wired!')
    if (!codeObj)
      codeObj = ''
    var payload
    if (!codeObj && codeObj !== false) {
      // sending nothing can be a means of keeping wire alive
      payload = PACK_BEGIN + wireDir + PACK_END
    } else if (codeObj instanceof ArrayBuffer) {
      // send binary from ArrayBuffer
      payload = codeObj
    } else if (codeObj.buffer instanceof ArrayBuffer) {
      // send binary from TypedArray
      payload = codeObj.buffer
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
          throw new Error("HBI does not send code object of type [" + typeof(codeObj) + "] yet, which is not convertible to JSON. " + (jsonErr ? jsonErr : ''))
        }
      }
      payload = PACK_BEGIN + wireDir + PACK_END + jsonCode
    }

    var continueSend = (ws.bufferedAmount < OPTIMAL_BUF_AMOUNT)
    ws.send(payload)
    if (cb) {
      if (continueSend) {
        setImmediate(cb)
      } else {
        // delay 1 ms for every extra 1KB buffered
        var delay = Math.round((ws.bufferedAmount - OPTIMAL_BUF_AMOUNT) / 1024)
        if (delay < MIN_DELAY)
          delay = MIN_DELAY
        if (delay > MAX_DELAY)
          delay = MAX_DELAY
        setTimeout(cb, delay)
      }
    }
    return continueSend
  }

  wire(ws) {
    if (this.transport) {
      throw new Error('This HBIC is already wired!')
    }
    this.transport = ws
    ws.onerror = (evt)=> {
      var err = new Error('error of ws to [' + ws.url + ']')
      if (!this.constructor.handleWireErr(this, ws, err))
        console.error(err)
    }
    ws.onclose = (evt)=> {
      if (evt.wasClean)
        return this.emit(hbi.WIRE_CLOSE_EVENT)
      var err = new Error('unexpected close of ws to [' + ws.url + '], code=[' + evt.code
        + '], reason=[' + evt.reason + ']')
      if (!this.constructor.handleWireErr(this, ws, err, evt))
        console.error(err)
    }
    if (!this.sendOnly) {
      ws.onmessage = (evt)=> {
        switch (typeof evt.data) {
          case 'string':
            var payload = evt.data
            if (!payload.startsWith(PACK_BEGIN)) {
              return this.constructor.handleWireErr(this, ws, new Error('HBI packet from [' + ws.url + '] malformed, invalid PACK_BEGIN: ' + payload.substr(0, PACK_BEGIN.length)))
            }
            var pePos = payload.substr(0, PACK_HEADER_MAX).indexOf(PACK_END, PACK_BEGIN.length)
            if (!pePos) {
              return this.constructor.handleWireErr(this, ws, new Error('HBI packet from [' + ws.url + '] malformed, no PACK_END found in header: ' + payload.substr(0, PACK_HEADER_MAX)))
            }
            var wireDir = payload.substring(PACK_BEGIN.length, pePos)
            payload = payload.substr(pePos + PACK_END.length)
            if (wireDir) {
              var wireErr
              try {
                if ('wire' === wireDir) {
                  // affair on the wire itself
                  ctx.runInContext(payload, this)
                } else {
                  // no more affairs implemented yet
                  wireErr = new Error('HBI packet header from [' + ws.url + '] malformed, invalid wire directive: ' + wireDir)
                }
              } catch (err) {
                wireErr = err
              }
              if (wireErr) {
                return this.constructor.handleWireErr(this, ws, wireErr)
              }
            } else {
              // got plain packet to be hosted, landing & treating
              var landingErr
              try {
                this.context.$peer$ = this
                ctx.runInContext(payload, this.context)
                this.context.$peer$ = null
                this.emit(CONSTS.PACKET_EVENT, payload)
              } catch (err) {
                landingErr = err
              }
              if (landingErr) {
                if (!this.constructor.handleLandingErr(this, ws, landingErr, payload)) {
                  // not recoverable, assume wire destroyed by handlLandingErr
                  return
                }
              }
            }

            if (this._dataSink) {
              // data sink planted during packet landing, but nothing to do for a ws transport here
            }

            break
          default:

            if (!this._dataSink) {
              return this.constructor.handleWireErr(this, ws, new Error('unexpected binary data'))
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

  resumeHosting(originalSink = null) {
    if (originalSink && this._dataSink !== originalSink) {
      throw new Error('unpaired offloadData/resumeHosting call')
    }
    this._dataSink = null
  }
  
  _destroyWire(ws) {
    if (!ws) {
      return
    }
    if (ws === this.transport) {
      this.transport = null
    }
    if (1 === ws.readyState || 0 === ws.readyState) {
      ws.close()
    }
  }

  disconnect(errReason, destroyDelay = CONSTS.DEFAULT_DISCONNECT_WAIT, transport = null) {
    var ws = transport || this.transport
    if (!ws) {
      return
    }
    if (ws === this.transport) {
      this.transport = null
    }
    if (1 !== ws.readyState) {
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
        this.constructor.sendPeerError(this, errReason, cbDestroy)
      } catch (err) {
        // ignore errors for last packet sending
      }
    } else {
      this._destroyWire(ws)
    }
  }

}


module.exports = WSHBIC
