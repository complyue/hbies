'use strict';

const EventEmitter = require('events')
const vm = require('vm')

const CONSTS = require('./constants')


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
    super()
    let ctx = context && vm.isContext(context) ? context : vm.createContext(context || {})
    ctx.emit = this.emit.bind(this)
    ctx.sendBack = this.send.bind(this)
    this.context = ctx
  }
  _socket() {
    let socket = this.socket
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
    socket.on('end', () => {
      // end when peer ends
      socket.end()
    })
    socket.on('data', (chunk) => {
      let chunkPos = 0
      chunk_processing: while (chunkPos < chunk.length) {
        if (!wireBuf.pdBuf) { // filling packet header
          if (wireBuf.phPos < PACK_HEADER_MAX) {
            let byts = chunk.copy(wireBuf.phBuf, wireBuf.phPos, chunkPos, Math.min(chunk.length, chunkPos + PACK_HEADER_MAX - wireBuf.phPos))
            wireBuf.phPos += byts
            chunkPos += byts
          }
          let hdrEnd = wireBuf.phBuf.slice(0, wireBuf.phPos - 1).indexOf(PACK_END)
          if (hdrEnd < 0) {
            if (wireBuf.phPos >= wireBuf.phBuf.length) {
              let err = new Error('HBI packet header from [' + socket.remoteAddress + ':' + socket.remotePort + '] overflow, no PACK_END found in first ' + PACK_HEADER_MAX + ' bytes: ' + wireBuf.phBuf.toString('utf8', 0, wireBuf.phPos))
              this.emit(CONSTS.HBI_WIRE_ERR_EVENT, err)
              this.disconnect()
            }
            // packet header not filled yet
            return
          }
          chunkPos -= wireBuf.phPos - hdrEnd - 1
          wireBuf.phPos = hdrEnd + 1
          if (wireBuf.phBuf[0] !== PACK_BEGIN) {
            let err = new Error('HBI packet header from [' + socket.remoteAddress + ':' + socket.remotePort + '] malformed, invalid PACK_BEGIN: ' + wireBuf.phBuf.toString('utf8', 0, wireBuf.phPos))
            this.emit(CONSTS.HBI_WIRE_ERR_EVENT, err)
            this.disconnect()
            return
          }
          let hdrStr = wireBuf.phBuf.toString('utf8', 1, wireBuf.phPos - 1)
          let plemp = hdrStr.indexOf(PACK_LEN_END)
          if (plemp < 0) {
            let err = new Error('HBI packet header from [' + socket.remoteAddress + ':' + socket.remotePort + '] malformed, no length end marker (' + PACK_LEN_END + '): ' + wireBuf.phBuf.toString('utf8', 0, wireBuf.phPos))
            this.emit(CONSTS.HBI_WIRE_ERR_EVENT, err)
            this.disconnect()
            return
          }
          let pl = parseInt(hdrStr.substring(0, plemp))
          if (!isFinite(pl)) {
            let err = new Error('HBI packet header from [' + socket.remoteAddress + ':' + socket.remotePort + '] malformed, invalid packet length: ' + wireBuf.phBuf.toString('utf8', 0, wireBuf.phPos))
            this.emit(CONSTS.HBI_WIRE_ERR_EVENT, err)
            this.disconnect()
            return
          }
          let hdrRest = hdrStr.substring(plemp + 1)
          if (hdrRest) {
            console.log('HBI packet header from [' + socket.remoteAddress + ':' + socket.remotePort + '] contains more stuff than understood here (which is ignored): ' + hdrRest)
          }
          wireBuf.pdBuf = new Buffer(pl)
          wireBuf.pdPos = 0
        }
        if (chunkPos >= chunk.length)
        // chunk exhausted, no packet body could be read
          return
        if (wireBuf.pdPos < wireBuf.pdBuf.length) {
          let byts = chunk.copy(wireBuf.pdBuf, wireBuf.pdPos, chunkPos, Math.min(chunk.length, chunkPos + wireBuf.pdBuf.length - wireBuf.pdPos))
          wireBuf.pdPos += byts
          chunkPos += byts
        }
        if (wireBuf.pdPos < wireBuf.pdBuf.length)
        // packet body not filled
          return
          // got packet body in pdBuf
        let payload = wireBuf.pdBuf.toString('utf8')
          // reset packet bufs
        wireBuf.phPos = 0
        wireBuf.pdPos = 0
        delete wireBuf.pdBuf

        // landing & treating
        try {
          this.context.peer = this
          let packet = vm.runInContext(payload, this.context)
          this.emit(CONSTS.HBI_PACK_EVENT, packet, payload)
        } catch (err) {
          // try emit as local landing err
          if (this.emit(CONSTS.HBI_LANDING_ERR_EVENT, err, payload)) {
            // landing errors are locally listened, and
            if (!this.socket || this.socket.destroyed) {
              // local listener(s) disconnected wire, 
              // also ignore rest packet(s) in chunk
              break chunk_processing
            } else {
              // assume local listener(s) handled this error without necessarity to disconnect
              // do nothing here and it'll loop to next packet
            }
          } else { // landing error not listened, disconnect forcefully by default
            // ignore rest socket data
            socket.pause()
              // bound to this socket, avoid disconnecting new wire established afterwards
            let cbDisconnThisSock = this.disconnect.bind(this, socket)
              // timed disconnect
            setTimeout(cbDisconnThisSock, PEER_ERR_SEND_MAX_TIME)
              // meanwhile make reasonable effort to send peer err emitting code to remote,
            try {
              // this races with the timed disconnect
              this.sendPeerError(err, cbDisconnThisSock)
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
    let socket = this._socket()
    let payload
    if (!codeObj && codeObj !== false) {
      // sending nothing can be a means of keeping wire alive
      payload = new Buffer(0)
    } else if (Buffer.isBuffer(codeObj)) {
      payload = codeObj
    } else {
      let jsonCode, jsonErr
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
    socket.write('[' + payload.length + PACK_LEN_END + ']', 'utf8')
    return socket.write(payload)
  }
  sendPeerError(err, cb) {
    if (this.send('emit("' + CONSTS.HBI_PEER_ERR_EVENT + '",' + JSON.stringify(err.stack || err + '') + ')')) {
      if (cb) cb()
    } else {
      if (cb) this.socket.once('drain', cb)
    }
  }
  end() {
    let socket = this.socket
    if (!socket) return
    socket.end()
  }
  disconnect(targetSocket) {
    let socket = this.socket
    if (!socket) return
    if (targetSocket && targetSocket !== socket)
    // closing an old connection, ignore
      return
    delete this.socket
    socket.end()
    socket.destroy()
  }
  get connected() {
    let socket = this.socket
    if (!socket) return false
    return !socket.destroyed
  }
}

module.exports = HBIC
