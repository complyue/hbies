'use strict';


class ObjectList {

  constructor() {
    this.head = null
    this.tail = null
    this.length = 0
  }

  push(obj) {
    if (!obj)
      return
    const entry = {obj: obj, next: null}
    if (this.length > 0)
      this.tail.next = entry
    else
      this.head = entry
    this.tail = entry
    this.length += 1
  }

  unshift(obj) {
    if (!obj)
      return
    const entry = {obj: obj, next: this.head}
    if (this.length === 0)
      this.tail = entry
    this.head = entry
    this.length += 1
  }

  shift() {
    if (this.length === 0)
      return
    const ret = this.head.obj
    if (this.head === this.tail)
      this.head = this.tail = null
    else
      this.head = this.head.next
    this.length -= 1
    return ret
  }

  clear() {
    this.head = this.tail = null
    this.length = 0
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
    this.clear()
    return nl
  }

}


module.exports = ObjectList

