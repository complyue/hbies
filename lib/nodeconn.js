'use strict';

const assert = require('assert')

const AbstractHBIC = require('./conn')

const ctx = require('./context')

/**
 * Hosting Based Interfacing Connection
 *
 * this class is an abstract class provide implementation details to run in a Node.js env
 */
module.exports = class NodeHBIC extends AbstractHBIC {

  static get ctx() {
    return ctx
  }

  static mapBuffer(buffer) {
    if (!buffer)
      return Buffer.alloc(0)
    if (buffer instanceof Buffer)
      return buffer
    if (buffer instanceof ArrayBuffer)
      return Buffer.from(buffer)
    var ab = buffer.buffer // in case of typed array
    if (ab instanceof ArrayBuffer)
      return Buffer.from(ab)
    return null
  }

  static copyBuffer(src, tgt, pos) {
    return src.copy(tgt, pos)
  }

  _checkWriteFlow(socket) {
    if (!socket || socket.destroyed)
      return true // conduct the calling party to fail quicker
    assert(socket._writableState)
    // this is some node internal but not seemingly varying soon
    if (socket._writableState.length > this.highWaterMarkSend) {
      return false
    }
    return true
  }

}
