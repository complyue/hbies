'use strict';

function estimateByteLen(obj) {
  if (!obj) {
    return 0
  }
  if ('string' === typeof obj) {
    // approximate to double of str length
    return obj.length << 1
  }
  if (obj instanceof Buffer) {
    return obj.length
  }
  if (obj instanceof ArrayBuffer) {
    return obj.byteLength
  }
  var ab = obj.buffer
  if (ab instanceof ArrayBuffer) {
    return ab.byteLength
  }
  // last resort to string coerce
  var sr = '' + obj
  return sr.length << 1
}

class ObjectList {

  constructor() {
    this.head = null
    this.tail = null
    this.length = 0
    this.byteLen = 0
  }

  push(obj) {
    if (!obj)
      return
    const entry = {obj: obj, byteLen: estimateByteLen(obj), next: null}
    if (this.length > 0)
      this.tail.next = entry
    else
      this.head = entry
    this.tail = entry
    this.length += 1
    this.byteLen += entry.byteLen
  }

  unshift(obj) {
    if (!obj)
      return
    const entry = {obj: obj, byteLen: estimateByteLen(obj), next: this.head}
    if (this.length === 0)
      this.tail = entry
    this.head = entry
    this.length += 1
    this.byteLen += entry.byteLen
  }

  shift() {
    if (this.length === 0)
      return
    const re = this.head
    if (this.head === this.tail)
      this.head = this.tail = null
    else
      this.head = this.head.next
    this.length -= 1
    this.byteLen -= re.byteLen
    return re.obj
  }

  clear() {
    this.head = this.tail = null
    this.length = 0
    this.byteLen = 0
  }

  [Symbol.iterator]() {
    return {
      curr: this.head,
      next: function () {
        if (this.curr) {
          var ret = {value: this.curr.obj, done: false}
          this.curr = this.curr.next
          return ret
        }
        return {done: true}
      }
    }
  }

  drain() {
    if (this.length === 0)
      return this
    var nl = new this.constructor()
    nl.head = this.head
    nl.tail = this.tail
    nl.length = this.length
    nl.byteLen = this.byteLen
    this.clear()
    return nl
  }

}


module.exports = ObjectList

