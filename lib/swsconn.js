'use strict';

const assert = require('assert')

const sws = require('nodejs-websocket')
const P = require('bluebird')

const CONSTS = require('./constants')

const ctx = require('./context')
const ObjectList = require('./objlist')

// max scanned length of packet header
const PACK_HEADER_MAX = 60
const PACK_BEGIN = '[#'
const PACK_END = ']'

const NodeHBIC = require('./nodeconn')

/**
 * Hosting Based Interfacing Connection
 *
 * this class runs in a Node.js env with WebSocket transport
 */
class SWSHBIC extends NodeHBIC {


  static createServer(contextFactory, hbicListener, {sendOnly = false}={}, netOpts = {}) {
    if ('function' !== typeof contextFactory)
      throw new TypeError('contextFactory should be a function')
    return sws.createServer(netOpts, (ws)=> {
      var hbic = new SWSHBIC(contextFactory(), null, {sendOnly})
      hbic.wire(ws)
      if (hbicListener) {
        hbicListener(hbic)
      }
    })
  }


  constructor(...args) {
    super(...args)

    this._objBuf = new ObjectList()
  }

  get netInfo() {
    var ws = this.transport
    if (!ws) return '<unwired>'

    if (ws.server) {
      // as server
      var path = ws.server.path || ''
      var sock = ws.socket
      if (!sock) return '<unwired>' + path
      if (sock.destroyed) return '<destroyed>' + path
      return '[' +
        sock.localAddress + ':' + sock.localPort +
        '] <=ws' + path + '=> [' +
        sock.remoteAddress + ':' + sock.remotePort +
        ']'
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
      resolve(this)
    })
    ws.once('error', reject)
  }


  _getSendWaterPos() {
    var ws = this.transport
    if (!ws)
      return 0
    var socket = ws.socket
    if (!socket || socket.destroyed)
      return 0
    assert(socket._writableState)
    // this is some node internal but not seemingly varying soon
    return socket._writableState.length
  }

  _getRecvWaterPos() {
    return this._recv_buffer.length + this._objBuf.byteLen
  }

  _pauseRecv() {
    var ws = this.transport
    if (!ws)
      return
    var socket = ws.socket
    if (!socket || socket.destroyed)
      return
    socket.pause()
  }

  _resumeRecv() {
    var ws = this.transport
    if (!ws)
      return
    var socket = ws.socket
    if (!socket || socket.destroyed)
      return
    socket.resume()
  }

  _landOne() {
    var packet = this._objBuf.shift()
    if (!packet) {
      return
    }
    return this.land(packet[0], packet[1])
  }

  _sendText(code, wireDir = '') {
    const ws = this.transport
    ws.sendText(PACK_BEGIN + wireDir + PACK_END + code)
    return this._checkWriteFlow(ws.socket)
  }

  _sendBuffer(buf) {
    if (!buf || buf.length <= 0)
      return true

    var ws = this.transport
    ws.sendBinary(buf)
    return this._checkWriteFlow(ws.socket)
  }

  wire(ws) {
    if (this.transport && (1 === ws.readyState || 0 === ws.readyState)) {
      throw new Error('This HBIC is already wired!')
    }
    this.transport = ws
    ws.on('error', (err)=> {
      if ('ECONNRESET' === err.code) {
        // this is so common on browser window close
        return
      }
      return this.handleWireErr(err, ws)
    })
    if (!this.sendOnly) {
      ws.on('close', ()=> {
        if (ws === this.transport) {
          this.transport = null

          this.emit(CONSTS.WIRE_CLOSE_EVENT, ws)

        }
      })
      ws.on('binary', (inStream)=> {
        if (!this._dataSink) {
          return this.handleWireErr(new Error('unexpected binary frame'), ws)
        }
        inStream.on('readable', ()=> {
          var chunk = inStream.read()
          this._recv_buffer.push(chunk)
          this._readWire()
        })
        inStream.on('end', ()=> {
          // seems nothing to do
        })
      })
      ws.on('text', (payload)=> {
        if (!payload.startsWith(PACK_BEGIN)) {
          return this.handleWireErr(new Error('HBI packet from [' + this.addr + '] malformed, invalid PACK_BEGIN: ' + payload.substr(0, PACK_BEGIN.length)), ws)
        }
        var pePos = payload.substr(0, PACK_HEADER_MAX).indexOf(PACK_END, PACK_BEGIN.length)
        if (!pePos) {
          return this.handleWireErr(new Error('HBI packet from [' + this.addr + '] malformed, no PACK_END found in header: ' + payload.substr(0, PACK_HEADER_MAX)), ws)
        }
        var wireDir = payload.substring(PACK_BEGIN.length, pePos)
        payload = payload.substr(pePos + PACK_END.length)

        this._objBuf.push([payload, wireDir])
        this._readWire()
      })
    }
  }

  _destroyWire(ws) {
    if (!ws) {
      return
    }
    if (1 === ws.readyState || 0 === ws.readyState) {
      ws.close()
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


module.exports = SWSHBIC
