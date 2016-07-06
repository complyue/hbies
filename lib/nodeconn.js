'use strict';

const AbstractHBIC = require('./conn')

/**
 * Hosting Based Interfacing Connection
 *
 * this class is an abstract class provide implementation details to run in a Node.js env
 */
module.exports = class NodeHBIC extends AbstractHBIC {

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
    throw new Error('Unsupported buffer of type [' + (typeof buffer) + '/'
      + (buffer.constructor && buffer.constructor.name) + ']')
  }

  static copyBuffer(src, tgt, pos) {
    return src.copy(tgt, pos)
  }

}
