'use strict';

const assert = require('assert')
const net = require('net')
const P = require('bluebird')

const CONSTS = require('./constants')

// max scanned length of packet header
const PACK_HEADER_MAX = 60
const PACK_BEGIN = '['.charCodeAt(0)
const PACK_LEN_END = '#'
const PACK_END = ']'.charCodeAt(0)

const NodeHBIC = require('./nodeconn')

/**
 * Hosting Based Interfacing Connection
 *
 * this class runs in a Node.js env with net.Socket transport
 */
class HBIC extends NodeHBIC {


  static createServer(context, hbicListener, {sendOnly = false}={}, netOpts) {
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
      return peer.constructor.handleWireErr(peer, err, this)
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
              return peer.constructor.handleWireErr(peer, new Error('HBI packet header from [' + this.remoteAddress + ':' + this.remotePort + '] overflow, no PACK_END found in first ' + PACK_HEADER_MAX + ' bytes: ' + peer._wireBuf.phBuf.toString('utf8', 0, peer._wireBuf.phPos)), this)
            }
            // packet header not filled yet
            return
          }
          chunkPos -= peer._wireBuf.phPos - hdrEnd - 1
          peer._wireBuf.phPos = hdrEnd + 1
          if (peer._wireBuf.phBuf[0] !== PACK_BEGIN) {
            return peer.constructor.handleWireErr(peer, new Error('HBI packet header from [' + this.remoteAddress + ':' + this.remotePort + '] malformed, invalid PACK_BEGIN: ' + peer._wireBuf.phBuf.toString('utf8', 0, peer._wireBuf.phPos)), this)
          }
          var hdrStr = peer._wireBuf.phBuf.toString('utf8', 1, peer._wireBuf.phPos - 1)
          var plemp = hdrStr.indexOf(PACK_LEN_END)
          if (plemp < 0) {
            return peer.constructor.handleWireErr(peer, new Error('HBI packet header from [' + this.remoteAddress + ':' + this.remotePort + '] malformed, no length end marker (' + PACK_LEN_END + '): ' + peer._wireBuf.phBuf.toString('utf8', 0, peer._wireBuf.phPos)), this)
          }
          var pl = parseInt(hdrStr.substring(0, plemp))
          if (!isFinite(pl)) {
            return peer.constructor.handleWireErr(peer, new Error('HBI packet header from [' + this.remoteAddress + ':' + this.remotePort + '] malformed, invalid packet length: ' + peer._wireBuf.phBuf.toString('utf8', 0, peer._wireBuf.phPos)), this)
          }
          if (++plemp >= hdrStr.length) {
            peer._wireBuf.wireDir = ''
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
        peer._wireBuf.wireDir = ''
        peer._wireBuf.pdPos = 0
        peer._wireBuf.pdBuf = null

        if (!peer.land(this, payload, wireDir)) {
          // unrecoverable failure in landing code
          return
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
    assert(this.addr)
    var opts = Object.assign({}, this.addr, this.netOpts)
    var socket = net.connect(opts, ()=> {
      socket.removeListener('error', reject)
      this.wire(socket)
      resolve()
    })
    socket.once('error', reject)
  }

  wire(socket, readAhead = null) {
    if (this.transport && !this.transport.destroy) {
      throw new Error('This HBIC is already wired!')
    }
    this.transport = socket
    socket.on('error', this._err_handler)
    socket.on('close', ()=> {
      if (socket === this.transport) {
        this.transport = null

        this.emit(CONSTS.WIRE_CLOSE_EVENT, socket)

      }
    })
    if (!this.sendOnly) {
      this._wireBuf = {
        phBuf: Buffer.allocUnsafeSlow(PACK_HEADER_MAX),
        phPos: 0,
        pdBuf: null,
        pdPos: 0
      }
      if (readAhead) {
        this._data_handler.call(socket, readAhead)
      }
      socket.on('data', this._data_handler)
    }
  }

  _getBufferedAmount() {
    var socket = this.transport
    if (!socket || socket.destroyed)
      return
    assert(socket._writableState)
    // this is some node internal but not seemingly varying soon
    return socket._writableState.length
  }

  _sendText(code, wireDir = '') {
    assert('string' === typeof code)
    var payload = Buffer.from(code, 'utf-8')
    var socket = this.transport
    socket.write('[' + payload.length + PACK_LEN_END + (wireDir || '') + ']', 'utf-8')
    socket.write(payload)
    return this._checkWriteFlow(socket)
  }

  _sendBuffer(buf) {
    var socket = this.transport
    if (buf && buf.length > 0) {
      socket.write(buf)
    }
    return this._checkWriteFlow(socket)
  }


  _destroyWire(socket) {
    if (!socket) {
      return
    }
    if (!socket.destroyed) {
      socket.destroy()
    }
    if (socket === this.transport) {
      this.transport = null
    }
  }

  disconnect(errReason, destroyDelay = CONSTS.DEFAULT_DISCONNECT_WAIT, transport = null) {
    var socket = transport || this.transport
    if (!socket) {
      return
    }
    if (socket.destroyed) {
      if (socket === this.transport) {
        this.transport = null
      }
      return
    }
    // ignore subsequent socket data
    socket.removeListener('data', this._data_handler)
    if (errReason && destroyDelay > 0) {
      var cbDestroy = ()=> {
        this._destroyWire(socket)
      }
      // timed unwire
      setTimeout(cbDestroy, destroyDelay)
      // meanwhile make reasonable effort to send the errReason as last packet
      try {
        // this races with the timed unwire
        this.sendPeerError(errReason)
        socket.end()
        if (socket === this.transport) {
          this.transport = null
        }
      } catch (err) {
        console.error(err)
      }
    } else {
      this._destroyWire(socket)
    }
  }

}


module.exports = HBIC
