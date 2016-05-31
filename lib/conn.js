'use strict';

const EventEmitter = require('events')
const vm = require('vm')

const CONSTS = require('./constants')

const WIRE_DIRECTIVE = 'wire'

// max scanned length of packet header
const PACK_HEADER_MAX = 20
const PACK_BEGIN = '['.charCodeAt(0)
const PACK_LEN_END = '#'
const PACK_END = ']'.charCodeAt(0)
const PEER_ERR_SEND_MAX_TIME = 30000

/**
 * Hosting Based Interfacing Connection
 */
class HBIC extends EventEmitter {
  constructor(context) {
    if ('object' !== typeof context)
      throw new Error('must supply an object as context')
    super()
    this.context = vm.isContext(context) ? context : vm.createContext(context)
  }

  _socket() {
    var socket = this.socket
    if (!socket)
      throw new Error('This HBIC is not wired!')
    return socket
  }

  wire(socket) {
    if (this.socket) {
      throw new Error('This HBIC is already wired!')
    }
    this.socket = socket
    const wireBuf = {
      phBuf: new Buffer(PACK_HEADER_MAX),
      phPos: 0
    }
    socket.on('error', (err) => {
      this.emit(CONSTS.WIRE_ERR_EVENT, err, socket)
    })
    socket.on('close', () => {
      if (socket === this.socket) {
        this.emit(CONSTS.WIRE_CLOSE_EVENT, socket)
        this.socket = null
      }
    })
    socket.on('end', () => {
      // end when peer ends
      socket.end()
    })
    socket.on('data', (chunk) => {
      var chunkPos = 0
      chunk_processing: while (chunkPos < chunk.length) {
        if (!wireBuf.pdBuf) { // filling packet header
          if (wireBuf.phPos < PACK_HEADER_MAX) {
            var byts = chunk.copy(wireBuf.phBuf, wireBuf.phPos, chunkPos, Math.min(chunk.length, chunkPos + PACK_HEADER_MAX - wireBuf.phPos))
            wireBuf.phPos += byts
            chunkPos += byts
          }
          var hdrEnd = wireBuf.phBuf.slice(0, wireBuf.phPos - 1).indexOf(PACK_END)
          if (hdrEnd < 0) {
            if (wireBuf.phPos >= wireBuf.phBuf.length) {
              var err = new Error('HBI packet header from [' + socket.remoteAddress + ':' + socket.remotePort + '] overflow, no PACK_END found in first ' + PACK_HEADER_MAX + ' bytes: ' + wireBuf.phBuf.toString('utf8', 0, wireBuf.phPos))
              this.emit(CONSTS.WIRE_ERR_EVENT, err, socket)
              this.unwire(socket)
            }
            // packet header not filled yet
            return
          }
          chunkPos -= wireBuf.phPos - hdrEnd - 1
          wireBuf.phPos = hdrEnd + 1
          if (wireBuf.phBuf[0] !== PACK_BEGIN) {
            var err = new Error('HBI packet header from [' + socket.remoteAddress + ':' + socket.remotePort + '] malformed, invalid PACK_BEGIN: ' + wireBuf.phBuf.toString('utf8', 0, wireBuf.phPos))
            this.emit(CONSTS.WIRE_ERR_EVENT, err, socket)
            this.unwire(socket)
            return
          }
          var hdrStr = wireBuf.phBuf.toString('utf8', 1, wireBuf.phPos - 1)
          var plemp = hdrStr.indexOf(PACK_LEN_END)
          if (plemp < 0) {
            var err = new Error('HBI packet header from [' + socket.remoteAddress + ':' + socket.remotePort + '] malformed, no length end marker (' + PACK_LEN_END + '): ' + wireBuf.phBuf.toString('utf8', 0, wireBuf.phPos))
            this.emit(CONSTS.WIRE_ERR_EVENT, err, socket)
            this.unwire(socket)
            return
          }
          var pl = parseInt(hdrStr.substring(0, plemp))
          if (!isFinite(pl)) {
            var err = new Error('HBI packet header from [' + socket.remoteAddress + ':' + socket.remotePort + '] malformed, invalid packet length: ' + wireBuf.phBuf.toString('utf8', 0, wireBuf.phPos))
            this.emit(CONSTS.WIRE_ERR_EVENT, err, socket)
            this.unwire(socket)
            return
          }
          if (++plemp >= hdrStr.length) {
            wireBuf.wireDir = null
          } else {
            wireBuf.wireDir = hdrStr.substr(plemp)
          }
          wireBuf.pdBuf = new Buffer(pl)
          wireBuf.pdPos = 0
        }
        if (chunkPos >= chunk.length)
        // chunk exhausted, no packet body could be read
          return
        if (wireBuf.pdPos < wireBuf.pdBuf.length) {
          var byts = chunk.copy(wireBuf.pdBuf, wireBuf.pdPos, chunkPos, Math.min(chunk.length, chunkPos + wireBuf.pdBuf.length - wireBuf.pdPos))
          wireBuf.pdPos += byts
          chunkPos += byts
        }
        if (wireBuf.pdPos < wireBuf.pdBuf.length)
        // packet body not filled
          return
        // got packet body in pdBuf
        var wireDir = wireBuf.wireDir
        var payload = wireBuf.pdBuf.toString('utf8')
        // reset packet bufs
        wireBuf.phPos = 0
        wireBuf.wireDir = null
        wireBuf.pdPos = 0
        wireBuf.pdBuf = null

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
              if (!this._wireCtx) {
                this._wireCtx = Object.create(this)
                this._wireCtx = vm.createContext(this._wireCtx)
              }
              vm.runInContext(payload, this._wireCtx)
              break;
            } else {
              // no more affairs implemented yet
              wireErr = new Error('HBI packet header from [' + socket.remoteAddress + ':' + socket.remotePort + '] malformed, invalid wire directive: ' + wireDir)
            }
          } catch (err) {
            wireErr = err
          }
          if (wireErr) {
            this.emit(CONSTS.WIRE_ERR_EVENT, wireErr, socket)
            socket.pause()
            this.unwire(socket)
            return
          }
          continue chunk_processing
        }

        // got plain packet to be hosted, landing & treating
        try {
          var packet = vm.runInContext(payload, this.context)
          this.emit(CONSTS.PACKET_EVENT, packet, payload)
        } catch (err) {
          // try emit as local landing err
          if (this.emit(CONSTS.LANDING_ERR_EVENT, err, payload, socket)) {
            // landing errors are locally listened, and
            if (!this.socket || this.socket.destroyed) {
              // local listener(s) disconnected wire,
              // also ignore rest packet(s) in chunk
              break chunk_processing
            } else {
              // assume local listener(s) handled this error without necessarity to disconnect
              // do nothing here and it'll loop to next packet
            }
          } else { // landing error not listened, by default, unwire forcefully after last attempt to send peer error
            // ignore rest socket data
            socket.pause()
            var cbUnwire = ()=> {
              this.unwire(socket)
            }
            // timed disconnect
            setTimeout(cbUnwire, PEER_ERR_SEND_MAX_TIME)
            // meanwhile make reasonable effort to send peer err emitting code to remote,
            try {
              // this races with the timed disconnect
              this.sendPeerError(err, cbUnwire)
            } catch (err) {
              // ignore errors for peer error sending
            }
            // break current packet processing loop
            break chunk_processing
          }
        }
      }
    })
  }

  send(codeObj) {
    this._send(codeObj)
  }

  sendWire(codeObj) {
    this._send(codeObj, WIRE_DIRECTIVE)
  }

  _send(codeObj, wireDir) {
    var socket = this._socket()
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
    return socket.write(payload)
  }

  sendPeerError(err, cb) {
    if (this.sendWire('this.emit("' + CONSTS.PEER_ERR_EVENT + '",' + JSON.stringify(err.stack || err + '') + ')')) {
      if (cb) cb()
    } else {
      if (cb) this.socket.once('drain', cb)
    }
  }

  unwire(targetSocket) {
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

  disconnect() {
    this.unwire(this.socket)
  }

  get connected() {
    var socket = this.socket
    if (!socket) return false
    return !socket.destroyed
  }
}

module.exports = HBIC
