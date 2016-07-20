'use strict';

const P = require('bluebird')


class PromisingMutex {

  constructor() {
    this.working = false
    this._waiters = []
  }

  orderly(promise) {

    const _leave = ()=> {
      assert(this.working, 'not in working while leave')
      this.working = false
      var [resolve,] = this._waiters.shift()
      if (resolve) {
        resolve()
      }
    }

    const _enter = ()=> {
      if (this.working) {
        // in working, schedule for waiting
        return new P((resolve, reject)=> {
          this._waiters.push([resolve, reject])
        }).disposer(_leave)
      }

      // not in working, enter right now
      this.working = true
      return P.resolve().disposer(_leave)
    }

    return P.using(_enter(), ()=>promise)

  }

  cancelAll(errReason) {
    var waiters = this._waiters
    if (waiters.length < 1)
      return
    this._waiters = []
    for (var [,reject] of waiters) {
      reject(errReason)
    }
  }

}


module.exports = PromisingMutex

