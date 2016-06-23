'use strict';

const assert = require('assert')
const EventEmitter = require('events')
const vm = require('vm')

const CONSTS = require('./constants')

const WIRE_DIRECTIVE = 'wire'

// max scanned length of packet header
const PACK_HEADER_MAX = 60
const PACK_BEGIN = '['.charCodeAt(0)
const PACK_LEN_END = '#'
const PACK_END = ']'.charCodeAt(0)

const DISCONNECT_LAST_WAIT = 30000


function handleWireErr(peer, socket, err, ...args) {
  if (!peer.emit(CONSTS.WIRE_ERR_EVENT, err, socket, ...args)) {
    console.error(err)
    throw err
  }
  peer._unwire(socket)
}


/**
 * Hosting Based Interfacing Connection
 */
class HBIC extends EventEmitter {

  constructor(context) {
    if ('object' !== typeof context)
      throw new Error('must supply an object as context')
    super()
    this.context = vm.isContext(context) ? context : vm.createContext(context)
    this.socket = null
    this.disconnecting = false
    this._dataSink = null
    // instance wide wire buffer, used to store partial packet data
    this._wireBuf = null

    const peer = this
    // define socket event listeners as properties, such that they can be explicitly removed when necessary
    // when these listener functions need to reference *this* hbic, they use *peer* defined above,
    // coz they'll be attached as net.Socket listeners, their *this* reference to the socket object

    this._err_handler = function (err) {
      //  this points to socket within this function
      return handleWireErr(peer, this, err)
    }
    this._close_handler = function () {
      //  this points to socket within this function
      if (this === peer.socket) {
        peer.emit(CONSTS.WIRE_CLOSE_EVENT, this)
        peer.socket = null
      }
    }
    this._end_handler = function () {
      // end outgoing while incoming ended by peer, this could only be invoked if wired socket allowHalfOpen
      this.end()
    }

    this._data_handler = function (chunk) {

      // if data sink is planted, simply forward data to it
      if (peer._dataSink) {
        return peer._dataSink(chunk)
      }

      // empty chunk is possible, just ignore processing
      if (!chunk || !chunk.length) {
        return
      }
      // receive packets and land them
      var chunkPos = 0
      chunk_processing: while (chunkPos < chunk.length) {
        if (peer.disconnecting) {
          // disconnect requested during landing or event process etc.
          break
        }
        if (!peer._wireBuf.pdBuf) { // filling packet header
          if (peer._wireBuf.phPos < PACK_HEADER_MAX) {
            var byts = chunk.copy(peer._wireBuf.phBuf, peer._wireBuf.phPos, chunkPos, Math.min(chunk.length, chunkPos + PACK_HEADER_MAX - peer._wireBuf.phPos))
            peer._wireBuf.phPos += byts
            chunkPos += byts
          }
          var hdrEnd = peer._wireBuf.phBuf.slice(0, peer._wireBuf.phPos - 1).indexOf(PACK_END)
          if (hdrEnd < 0) {
            if (peer._wireBuf.phPos >= peer._wireBuf.phBuf.length) {
              return handleWireErr(peer, this, new Error('HBI packet header from [' + this.remoteAddress + ':' + this.remotePort + '] overflow, no PACK_END found in first ' + PACK_HEADER_MAX + ' bytes: ' + peer._wireBuf.phBuf.toString('utf8', 0, peer._wireBuf.phPos)))
            }
            // packet header not filled yet
            return
          }
          chunkPos -= peer._wireBuf.phPos - hdrEnd - 1
          peer._wireBuf.phPos = hdrEnd + 1
          if (peer._wireBuf.phBuf[0] !== PACK_BEGIN) {
            return handleWireErr(peer, this, new Error('HBI packet header from [' + this.remoteAddress + ':' + this.remotePort + '] malformed, invalid PACK_BEGIN: ' + peer._wireBuf.phBuf.toString('utf8', 0, peer._wireBuf.phPos)))
          }
          var hdrStr = peer._wireBuf.phBuf.toString('utf8', 1, peer._wireBuf.phPos - 1)
          var plemp = hdrStr.indexOf(PACK_LEN_END)
          if (plemp < 0) {
            return handleWireErr(peer, this, new Error('HBI packet header from [' + this.remoteAddress + ':' + this.remotePort + '] malformed, no length end marker (' + PACK_LEN_END + '): ' + peer._wireBuf.phBuf.toString('utf8', 0, peer._wireBuf.phPos)))
          }
          var pl = parseInt(hdrStr.substring(0, plemp))
          if (!isFinite(pl)) {
            return handleWireErr(peer, this, new Error('HBI packet header from [' + this.remoteAddress + ':' + this.remotePort + '] malformed, invalid packet length: ' + peer._wireBuf.phBuf.toString('utf8', 0, peer._wireBuf.phPos)))
          }
          if (++plemp >= hdrStr.length) {
            peer._wireBuf.wireDir = null
          } else {
            peer._wireBuf.wireDir = hdrStr.substr(plemp)
          }
          peer._wireBuf.pdBuf = Buffer.allocUnsafe(pl)
          peer._wireBuf.pdPos = 0
        }
        if (chunkPos >= chunk.length) {
          // chunk exhausted, no packet body could be read
          break chunk_processing
        }
        if (peer._wireBuf.pdPos < peer._wireBuf.pdBuf.length) {
          var byts = chunk.copy(peer._wireBuf.pdBuf, peer._wireBuf.pdPos, chunkPos, Math.min(chunk.length, chunkPos + peer._wireBuf.pdBuf.length - peer._wireBuf.pdPos))
          peer._wireBuf.pdPos += byts
          chunkPos += byts
        }
        if (peer._wireBuf.pdPos < peer._wireBuf.pdBuf.length) {
          // packet body not filled
          break chunk_processing
        }
        // got packet body in pdBuf
        var wireDir = peer._wireBuf.wireDir
        var payload = peer._wireBuf.pdBuf.toString('utf8')
        // reset packet bufs
        peer._wireBuf.phPos = 0
        peer._wireBuf.wireDir = null
        peer._wireBuf.pdPos = 0
        peer._wireBuf.pdBuf = null

        if (wireDir) {
          // got wire affair packet, landing
          var wireErr
          try {
            if (WIRE_DIRECTIVE === wireDir) {
              /* affair on the wire itself
               use a wire object (which takes this conn obj as prototype) as context, avoid unintentional pollution
               to this conn obj by erroneous peers
               create this wire obj on first request, it may never be requested in some cases
               */
              if (!peer._wireCtx) {
                peer._wireCtx = vm.createContext(Object.create(peer))
              }
              vm.runInContext(payload, peer._wireCtx)
              break;
            } else {
              // no more affairs implemented yet
              wireErr = new Error('HBI packet header from [' + this.remoteAddress + ':' + this.remotePort + '] malformed, invalid wire directive: ' + wireDir)
            }
          } catch (err) {
            wireErr = err
          }
          if (wireErr) {
            return handleWireErr(peer, this, wireErr)
          }
        } else {
          // got plain packet to be hosted, landing & treating
          try {
            peer.context.$peer$ = peer
            var packet = vm.runInContext(payload, peer.context)
            peer.context.$peer$ = null
            peer.emit(CONSTS.PACKET_EVENT, packet, payload)
          } catch (err) {
            // try emit as local landing err
            if (peer.emit(CONSTS.LANDING_ERR_EVENT, err, payload, this)) {
              // landing errors are locally listened, and
              if (this.destroyed || peer.disconnecting) {
                // local listener(s) disconnected wire,
                // also ignore rest packet(s) in chunk
                break chunk_processing
              } else {
                // assume local listener(s) handled this error without necessarity to disconnect
                // do nothing here and it'll loop to next packet
              }
            } else {
              // landing error not listened, by default, unwire forcefully after last attempt to send peer error
              peer.disconnect(err)
              // break current packet processing loop
              break chunk_processing
            }
          }
        }

        if (peer._dataSink) {
          // data sink planted during packet landing, sink remaining data to it
          if (chunkPos < chunk.length) {
            peer._dataSink(chunk.slice(chunkPos))
          }
          return
        }

      }
    }
  }

  get netInfo() {
    var sock = this.socket
    if (!sock) return '<unwired>'
    if (sock.destroyed) return '<destroyed>'
    return '[' +
      sock.localAddress + ':' + sock.localPort +
      '] <=> [' +
      sock.remoteAddress + ':' + sock.remotePort +
      ']'
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
    sink(Buffer.alloc(0))
  }

  resumeHosting(readAhead, originalSink = null) {
    if (originalSink && this._dataSink !== originalSink) {
      throw new Error('unpaired offloadData/resumeHosting call')
    }
    this._dataSink = null
    if (readAhead) {
      this._data_handler(readAhead)
    }
  }

  wire(socket, {sendOnly=false, readAhead=null}={}) {
    if (this.socket) {
      throw new Error('This HBIC is already wired!')
    }
    this.disconnecting = false
    this.socket = socket
    socket.on('error', this._err_handler)
    socket.on('close', this._close_handler)
    if (!sendOnly) {
      this._wireBuf = {
        phBuf: Buffer.allocUnsafeSlow(PACK_HEADER_MAX),
        phPos: 0,
        pdBuf: null,
        pdPos: 0
      }
      socket.on('end', this._end_handler)
      socket.on('data', this._data_handler)
      if (readAhead) {
        this._data_handler.call(socket, readAhead)
      }
    }
  }

  send(codeObj, cb) {
    return this._send(codeObj, cb)
  }

  sendWire(codeObj, cb) {
    return this._send(codeObj, cb, WIRE_DIRECTIVE)
  }

  _send(codeObj, cb, wireDir) {
    var socket = this.socket
    if (!socket)
      throw new Error('This HBIC is not wired!')
    var payload
    if (!codeObj && codeObj !== false) {
      // sending nothing can be a means of keeping wire alive
      payload = new Buffer(0)
    } else if (Buffer.isBuffer(codeObj)) {
      payload = codeObj
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
      payload = new Buffer(jsonCode, 'utf8')
    }
    socket.write('[' + payload.length + PACK_LEN_END + (wireDir || '') + ']', 'utf8')
    return socket.write(payload, cb)
  }

  sendPeerError(err, cb) {
    return this.sendWire('this.emit("' + CONSTS.PEER_ERR_EVENT + '",' + JSON.stringify(err + '') + ')', cb)
  }

  _unwire(targetSocket) {
    var socket = this.socket
    if (!socket) return
    if (targetSocket && targetSocket !== socket)
    // closing an old connection, ignore
      return
    this.socket = null
    if (!socket.destroyed) {
      socket.destroy()
    }
  }

  disconnect(errReason, unwireDelay = DISCONNECT_LAST_WAIT) {
    this.disconnecting = true
    var socket = this.socket
    if (!socket || socket.destroyed) {
      return
    }
    // ignore subsequent socket data
    socket.pause()
    if (errReason) {
      var cbUnwire = ()=> {
        this._unwire(socket)
      }
      // timed unwire
      setTimeout(cbUnwire, unwireDelay)
      // meanwhile make reasonable effort to send the errReason as last packet
      try {
        // this races with the timed unwire
        this.sendPeerError(errReason, cbUnwire)
      } catch (err) {
        // ignore errors for last packet sending
      }
    } else {
      this._unwire(socket)
    }
  }

  get connected() {
    var socket = this.socket
    if (!socket) return false
    if (socket.destroyed) return false
    if (this.disconnecting) return false
    return true
  }
}


module.exports = HBIC
