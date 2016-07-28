'use strict';

const P = require('bluebird')

const CONSTS = require('./constants')

const ctx = require('./light-context')
const ObjectList = require('./objlist')

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

  static isBuffer(obj) {
    if (obj instanceof Uint8Array)
      return true
    if (obj instanceof ArrayBuffer)
      return true
    var ab = obj.buffer
    if (ab instanceof ArrayBuffer)
      return true
    return false
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

    this._objBuf = new ObjectList()
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

  _getBufferedAmount() {
    var ws = this.transport
    return ws.bufferedAmount
  }

  _pauseRecv() {
    // browser ws can not be paused/resumed, nop here
  }

  _resumeRecv() {
    // browser ws can not be paused/resumed, nop here
  }

  _landOne() {
    var packet = this._objBuf.shift()
    if (!packet) {
      return
    }
    return this.land(packet[0], packet[1])
  }

  _sendText(code, wireDir = '') {
    var ws = this.transport
    ws.send(PACK_BEGIN + wireDir + PACK_END + code)
    return ws.bufferedAmount < this.highWaterMarkSend
  }

  _sendBuffer(buf) {
    const ws = this.transport
    if (buf && buf.length > 0) {
      ws.send(buf)
    }
    return ws.bufferedAmount < this.highWaterMarkSend
  }

  wire(ws) {
    if (this.transport) {
      throw new Error('This HBIC is already wired!')
    }
    this.transport = ws
    ws.onerror = (evt)=> {
      var err = new Error('error of ws to [' + ws.url + ']')
      if (!this.handleWireErr(err, ws))
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
              return this.handleWireErr(new Error('HBI packet from [' + ws.url + '] malformed, invalid PACK_BEGIN: ' + payload.substr(0, PACK_BEGIN.length)), ws)
            }
            var pePos = payload.substr(0, PACK_HEADER_MAX).indexOf(PACK_END, PACK_BEGIN.length)
            if (!pePos) {
              return this.handleWireErr(new Error('HBI packet from [' + ws.url + '] malformed, no PACK_END found in header: ' + payload.substr(0, PACK_HEADER_MAX)), ws)
            }
            var wireDir = payload.substring(PACK_BEGIN.length, pePos)
            payload = payload.substr(pePos + PACK_END.length)

            this._objBuf.push([payload, wireDir])
            this._readWire()

            break
          default:

            this._buffer.push(evt.data)
            this._readWire()

            break
        }
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
