'use strict';


class BufferList {

  constructor() {
    this.head = null
    this.tail = null
    this.length = 0
  }

  push(v) {
    if (!v || v.length <= 0)
      return
    const entry = {data: v, next: null}
    if (this.length > 0)
      this.tail.next = entry
    else
      this.head = entry
    this.tail = entry
    this.length += v.length
  }

  unshift(v) {
    if (!v || v.length <= 0)
      return
    const entry = {data: v, next: this.head}
    if (this.length === 0)
      this.tail = entry
    this.head = entry
    this.length += v.length
  }

  shift() {
    if (this.length === 0)
      return
    const ret = this.head.data
    if (this.head === this.tail)
      this.head = this.tail = null
    else
      this.head = this.head.next
    this.length -= ret.length
    return ret
  }

  clear() {
    this.head = this.tail = null
    this.length = 0
  }

}


module.exports = BufferList

