'use strict';

const sws = require('nodejs-websocket')

const CONSTS = require('./constants')

const ctx = require('./context')

// max scanned length of packet header
const PACK_HEADER_MAX = 60
const PACK_BEGIN = '[#'
const PACK_END = ']'

const AbstractHBIC = require('./conn')

/**
 * Hosting Based Interfacing Connection
 *
 * this class runs in a Node.js env with WebSocket transport
 */
class SWSHBIC extends AbstractHBIC {

  static createServer(context, hbicListener, {sendOnly=false}={}, netOpts) {
    return sws.createServer(netOpts, (ws)=> {
      var hbic = new SWSHBIC(context, null, {sendOnly})
      hbic.wire(ws)
      if (hbicListener) {
        hbicListener(hbic)
      }
    })
  }

  constructor(...args) {
    super(...args)

    this._dataSink = null
  }

  get netInfo() {
    var ws = this.transport
    if (!ws) return '<unwired>'

    if (ws.server) {
      // as server
      var path = ws.server.path
      var sock = ws.socket
      if (!sock) return '<unwired>' + path
      if (sock.destroyed) return '<destroyed>' + path
      return '[' +
        sock.localAddress + ':' + sock.localPort +
        '] <=> [' +
        sock.remoteAddress + ':' + sock.remotePort +
        ']' + path
    }

    // as client
    if (!this.addr) {
      return '<destroyed>'
    }
    switch (ws.readyState) {
      case 0:
        return '<connecting:' + this.addr + '>'
      case 1:
        return '<connected:' + this.addr + '>'
      case 2:
        return '<disconnecting:' + this.addr + '>'
      case 3:
        return '<disconnected:' + this.addr + '>'
      default:
        return '<sws:' + this.addr + '>'
    }
  }

  get connected() {
    var ws = this.transport
    if (!ws) return false
    if (1 === ws.readyState || 0 === ws.readyState) return true
    return false
  }

  _connect(resolve, reject) {
    var ws = sws.connect(this.addr, this.netOpts, ()=> {
      ws.removeListener('error', reject)
      this.wire(ws)
      resolve()
    })
    ws.once('error', reject)
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
      return ws.sendText(payload, cb)
    } else if (Buffer.isBuffer(codeObj)) {
      payload = codeObj
      return ws.sendBinary(payload, cb)
    } else if (codeObj instanceof ArrayBuffer) {
      // send binary from ArrayBuffer
      payload = Buffer.from(codeObj)
      return ws.sendBinary(payload, cb)
    } else if (codeObj.buffer instanceof ArrayBuffer) {
      // send binary from TypedArray
      payload = Buffer.from(codeObj.buffer)
      return ws.sendBinary(payload, cb)
    }

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
    return ws.sendText(payload, cb)
  }

  wire(ws) {
    if (this.transport) {
      throw new Error('This HBIC is already wired!')
    }
    this.transport = ws
    if (!this.sendOnly) {
      ws.on('binary', (inStream)=> {
        if (!this._dataSink) {
          return this.constructor.handleWireErr(this, ws, new Error('unexpected binary data'))
        }
        this._dataSink(inStream)
      })
      ws.on('text', (payload)=> {
        if (!payload.startsWith(PACK_BEGIN)) {
          return this.constructor.handleWireErr(this, ws, new Error('HBI packet from [' + this.addr + '] malformed, invalid PACK_BEGIN: ' + payload.substr(0, PACK_BEGIN.length)))
        }
        var pePos = payload.substr(0, PACK_HEADER_MAX).indexOf(PACK_END, PACK_BEGIN.length)
        if (!pePos) {
          return this.constructor.handleWireErr(this, ws, new Error('HBI packet from [' + this.addr + '] malformed, no PACK_END found in header: ' + payload.substr(0, PACK_HEADER_MAX)))
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
              wireErr = new Error('HBI packet header from [' + this.addr + '] malformed, invalid wire directive: ' + wireDir)
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

      })
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
    ws.removeAllListeners('text')
    ws.removeAllListeners('binary')
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


module.exports = SWSHBIC
