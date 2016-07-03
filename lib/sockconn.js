'use strict';

const net = require('net')

const CONSTS = require('./constants')

const ctx = require('./context')

// max scanned length of packet header
const PACK_HEADER_MAX = 60
const PACK_BEGIN = '['.charCodeAt(0)
const PACK_LEN_END = '#'
const PACK_END = ']'.charCodeAt(0)

const AbstractHBIC = require('./conn')


/**
 * Hosting Based Interfacing Connection
 *
 * this class runs in a Node.js env with net.Socket transport
 */
class HBIC extends AbstractHBIC {

  static createServer(context, hbicListener, {sendOnly=false}={}, netOpts) {
    const hbis = net.createServer(netOpts, (socket)=> {
      var hbic = new HBIC(context, null, {sendOnly})
      hbic.wire(socket)
      if (hbicListener) {
        hbicListener(hbic)
      }
    })
    return hbis
  }

  constructor(...args) {
    super(...args)

    this._dataSink = null
    // instance wide wire buffer, used to store partial packet data
    this._wireBuf = null

    const peer = this
    // define socket event listeners as properties, such that they can be explicitly removed when necessary
    // when these listener functions need to reference *this* hbic, they use *peer* defined above,
    // coz they'll be attached as net.Socket listeners, their *this* reference to the socket object

    this._err_handler = function (err) {
      //  this points to socket within this function
      return this.constructor.handleWireErr(peer, this, err)
    }
    this._close_handler = function () {
      //  this points to socket within this function
      if (this === peer.transport) {
        peer.emit(CONSTS.WIRE_CLOSE_EVENT, this)
        peer.transport = null
      }
    }
    this._end_handler = function () {
      // end outgoing while incoming ended by peer,
      // this could only be invoked if wired a socket with allowHalfOpen option
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
        if (!peer.connected) {
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
              return peer.constructor.handleWireErr(peer, this, new Error('HBI packet header from [' + this.remoteAddress + ':' + this.remotePort + '] overflow, no PACK_END found in first ' + PACK_HEADER_MAX + ' bytes: ' + peer._wireBuf.phBuf.toString('utf8', 0, peer._wireBuf.phPos)))
            }
            // packet header not filled yet
            return
          }
          chunkPos -= peer._wireBuf.phPos - hdrEnd - 1
          peer._wireBuf.phPos = hdrEnd + 1
          if (peer._wireBuf.phBuf[0] !== PACK_BEGIN) {
            return peer.constructor.handleWireErr(peer, this, new Error('HBI packet header from [' + this.remoteAddress + ':' + this.remotePort + '] malformed, invalid PACK_BEGIN: ' + peer._wireBuf.phBuf.toString('utf8', 0, peer._wireBuf.phPos)))
          }
          var hdrStr = peer._wireBuf.phBuf.toString('utf8', 1, peer._wireBuf.phPos - 1)
          var plemp = hdrStr.indexOf(PACK_LEN_END)
          if (plemp < 0) {
            return peer.constructor.handleWireErr(peer, this, new Error('HBI packet header from [' + this.remoteAddress + ':' + this.remotePort + '] malformed, no length end marker (' + PACK_LEN_END + '): ' + peer._wireBuf.phBuf.toString('utf8', 0, peer._wireBuf.phPos)))
          }
          var pl = parseInt(hdrStr.substring(0, plemp))
          if (!isFinite(pl)) {
            return peer.constructor.handleWireErr(peer, this, new Error('HBI packet header from [' + this.remoteAddress + ':' + this.remotePort + '] malformed, invalid packet length: ' + peer._wireBuf.phBuf.toString('utf8', 0, peer._wireBuf.phPos)))
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
            if ('wire' === wireDir) {
              // affair on the wire itself
              ctx.runInContext(payload, peer)
            } else {
              // no more affairs implemented yet
              wireErr = new Error('HBI packet header from [' + this.remoteAddress + ':' + this.remotePort + '] malformed, invalid wire directive: ' + wireDir)
            }
          } catch (err) {
            wireErr = err
          }
          if (wireErr) {
            return peer.constructor.handleWireErr(peer, this, wireErr)
          }
        } else {
          // got plain packet to be hosted, landing & treating
          var landingErr
          try {
            peer.context.$peer$ = peer
            ctx.runInContext(payload, peer.context)
            peer.context.$peer$ = null
            peer.emit(CONSTS.PACKET_EVENT, payload)
          } catch (err) {
            landingErr = err
          }
          if (landingErr) {
            if (!peer.constructor.handleLandingErr(peer, this, landingErr, payload)) {
              // not recoverable, assume wire destroyed by handlLandingErr
              return
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
    var sock = this.transport
    if (!sock) return '<unwired>'
    if (sock.destroyed) return '<destroyed>'
    return '[' +
      sock.localAddress + ':' + sock.localPort +
      '] <=> [' +
      sock.remoteAddress + ':' + sock.remotePort +
      ']'
  }

  get connected() {
    var socket = this.transport
    if (!socket) return false
    if (socket.destroyed) return false
    return true
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

  _connect(resolve, reject) {
    var socket = net.connect(Object.assign(this.addr, this.netOpts), ()=> {
      socket.removeListener('error', reject)
      this.wire(socket)
      resolve()
    })
    socket.once('error', reject)
  }

  wire(socket, readAhead = null) {
    if (this.transport) {
      throw new Error('This HBIC is already wired!')
    }
    this.transport = socket
    socket.on('error', this._err_handler)
    socket.on('close', this._close_handler)
    if (!this.sendOnly) {
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

  _send(codeObj, cb, wireDir) {
    var socket = this.transport
    if (!socket)
      throw new Error('This HBIC is not wired!')
    var payload
    if (!codeObj && codeObj !== false) {
      // sending nothing can be a means of keeping wire alive
      payload = Buffer.alloc(0)
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
      payload = Buffer.from(jsonCode, 'utf8')
    }
    socket.write('[' + payload.length + PACK_LEN_END + (wireDir || '') + ']', 'utf8')
    return socket.write(payload, cb)
  }

  _destroyWire(socket) {
    if (!socket) {
      return
    }
    if (socket === this.transport) {
      this.transport = null
    }
    if (!socket.destroyed) {
      socket.destroy()
    }
  }

  disconnect(errReason, destroyDelay = CONSTS.DISCONNECT_LAST_WAIT, transport = null) {
    var socket = transport || this.transport
    if (!socket) {
      return
    }
    if (socket === this.transport) {
      this.transport = null
    }
    if (socket.destroyed) {
      return
    }
    // ignore subsequent socket data
    socket.pause()
    if (errReason) {
      var cbDestroy = ()=> {
        this._destroyWire(socket)
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
      this._destroyWire(socket)
    }
  }

}


module.exports = HBIC
