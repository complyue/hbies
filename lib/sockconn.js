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


  static createServer(contextFactory, hbicListener, {sendOnly = false}={}, netOpts) {
    const hbis = net.createServer(netOpts, (socket)=> {
      var hbic = new HBIC(contextFactory(), null, {sendOnly})
      hbic.wire(socket)
      if (hbicListener) {
        hbicListener(hbic)
      }
    })
    return hbis
  }


  constructor(...args) {
    super(...args)

    // instance wide wire buffer, used to store partial packet data
    this._wireBuf = null

    const peer = this
    // define socket event listeners as properties, such that they can be explicitly removed when necessary
    // when these listener functions need to reference *this* hbic, they use *peer* defined above,
    // coz they'll be attached as net.Socket listeners, their *this* reference to the socket object

    this._err_handler = function (err) {
      //  this points to socket within this function
      return peer.handleWireErr(err, this)
    }

    this._data_handler = function (chunk) {

      // empty chunk is possible, just ignore from here
      if (chunk && chunk.length > 0) {
        // push new data into the buffer if not empty
        peer._buffer.push(chunk)
      }

      // parse the buffer and flow control with regards to hosting or corun mode
      peer._readWire()
    }
  }

  _pauseRecv() {
    var socket = this.transport
    if (!socket || socket.destroyed)
      return
    socket.pause()
  }

  _resumeRecv() {
    var socket = this.transport
    if (!socket || socket.destroyed)
      return
    socket.resume()
  }

  /**
   * pump/land one packet from this._buffer
   */
  _landOne() {
    var chunk
    while (chunk = this._buffer.shift()) {
      if (chunk.length <= 0)
      // ignore empty chunk anyway
        continue

      // process this chunk
      var chunkPos = 0
      while (true) {
        if (!this._wireBuf.pdBuf) { // filling packet header
          var hdrEnd = chunk.indexOf(PACK_END, chunkPos)
          if (hdrEnd < 0) {
            // packet header end not found
            if (chunk.length - chunkPos + this._wireBuf.phPos >= PACK_HEADER_MAX) {
              this.handleWireErr(new Error('HBI packet header from ' + this.netInfo
                  + ' overflow, no PACK_END found in first ' + PACK_HEADER_MAX + ' bytes: ['
                  + this._wireBuf.phBuf.toString('utf8', 0, this._wireBuf.phPos)) + ']')
              // this is not recoverable, return nothing from here, err should have been propagated
              return
            }
            // just now enough data input, consume this chunk and proceed to next chunk
            chunk.copy(this._wireBuf.phBuf, this._wireBuf.phPos, chunkPos)
            break
          }
          // found packet header end, fill header buffer
          chunk.copy(this._wireBuf.phBuf, this._wireBuf.phPos, chunkPos, hdrEnd + 1)
          chunkPos = hdrEnd + 1
          this._wireBuf.phPos += hdrEnd + 1
          // got packet header
          if (this._wireBuf.phBuf[0] !== PACK_BEGIN) {
            this.handleWireErr(new Error('HBI packet header from ' + this.netInfo
              + ' malformed, invalid PACK_BEGIN: [' + this._wireBuf.phBuf.toString('utf8', 0, this._wireBuf.phPos)
              + ']'))
            // this is not recoverable, return nothing from here, err should have been propagated
            return
          }
          var hdrStr = this._wireBuf.phBuf.toString('utf8', 1, this._wireBuf.phPos - 1)
          var plemp = hdrStr.indexOf(PACK_LEN_END)
          if (plemp < 0) {
            this.handleWireErr(new Error('HBI packet header from ' + this.netInfo
              + ' malformed, no length end marker (' + PACK_LEN_END + '): ['
              + this._wireBuf.phBuf.toString('utf8', 0, this._wireBuf.phPos) + ']'))
            // this is not recoverable, return nothing from here, err should have been propagated
            return
          }
          var pl = parseInt(hdrStr.substring(0, plemp))
          if (!isFinite(pl)) {
            this.handleWireErr(new Error('HBI packet header from ' + this.netInfo
              + ' malformed, invalid packet length: [' + this._wireBuf.phBuf.toString('utf8', 0, this._wireBuf.phPos)
              + ']'))
            // this is not recoverable, return nothing from here, err should have been propagated
            return
          }
          if (++plemp >= hdrStr.length) {
            this._wireBuf.wireDir = ''
          } else {
            this._wireBuf.wireDir = hdrStr.substr(plemp)
          }
          this._wireBuf.pdBuf = Buffer.allocUnsafe(pl)
          this._wireBuf.pdPos = 0
        }
        if (chunkPos >= chunk.length) {
          // chunk exhausted, no packet body could be read
          break
        }
        if (this._wireBuf.pdPos < this._wireBuf.pdBuf.length) {
          var byts = chunk.copy(this._wireBuf.pdBuf, this._wireBuf.pdPos, chunkPos,
            Math.min(chunk.length, chunkPos + this._wireBuf.pdBuf.length - this._wireBuf.pdPos))
          this._wireBuf.pdPos += byts
          chunkPos += byts
        }
        if (this._wireBuf.pdPos < this._wireBuf.pdBuf.length) {
          // packet body not filled
          assert(chunkPos >= chunk.length, 'chunk should have been exhausted')
          break
        }
        // if this chunk is not exhausted, prepend back to buffer
        if (chunkPos < chunk.length) {
          this._buffer.unshift(chunk.slice(chunkPos))
        }
        // got packet body in pdBuf
        var wireDir = this._wireBuf.wireDir
        var payload = this._wireBuf.pdBuf.toString('utf-8')
        // reset packet bufs
        this._wireBuf.phPos = 0
        this._wireBuf.wireDir = ''
        this._wireBuf.pdPos = 0
        this._wireBuf.pdBuf = null

        return this.land(payload, wireDir)
      }

    }
    // all buffered data processed and no packet landed
    return
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

  _connect(resolve, reject) {
    assert(this.addr)
    var opts = Object.assign({}, this.addr, this.netOpts)
    var socket = net.connect(opts, ()=> {
      socket.removeListener('error', reject)
      this.wire(socket)
      resolve(this)
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
    if (!socket || socket.destroyed) {
      throw new Error('wire disconnected')
    }
    socket.write('[' + payload.length + PACK_LEN_END + (wireDir || '') + ']', 'utf-8')
    socket.write(payload)
    return this._checkWriteFlow(socket)
  }

  _sendBuffer(buf) {
    var socket = this.transport
    if (!socket || socket.destroyed) {
      throw new Error('wire disconnected')
    }
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
      this._buffer.clear()
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
        this.sendPeerError(errReason).then(()=> {
          socket.end()
          if (socket === this.transport) {
            this.transport = null
          }
        })
      } catch (err) {
        console.error(err)
      }
    } else {
      this._destroyWire(socket)
    }
  }

}


module.exports = HBIC
