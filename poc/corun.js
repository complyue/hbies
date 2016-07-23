'use strict';

const assert = require('assert')

const P = require('bluebird')

var setImmediate
if (!setImmediate) {
  setImmediate = function (fn) {
    setTimeout(fn, 0, Array.prototype.slice.apply(arguments, 1))
  }
}

class HBIC {

  /**
   * run a generator and return a Promise wrapping its fate
   *
   * @param g a generator
   */
  static promise(g) {

    if (!g || 'function' !== typeof g.next || 'function' !== typeof g.throw) {
      throw new Error('one generator is expected')
    }

    return new P((resolve, reject)=> {

      // this function drives the generator one step further
      const itrun = (awv)=> {

        if (awv && 'function' === typeof awv.then) {
          // a promise as the awaited value, chain to its resolution
          awv.then((rv)=> {
            setImmediate(itrun, rv)
          }, (err)=> {
            // if the awaited promise rejects, propagate the err to generator
            try {
              var itr = g.throw(err)
              // to here, the generator handled the err
              if (itr.done) {
                // the generator returned, resolve and all done
                resolve(itr.value)
              } else {
                // the generator continued, step it later
                setImmediate(itrun, itr.value)
              }
            } catch (gerr) {
              // the generator threw, reject and all done
              reject(gerr)
            }
          })
          return
        }

        // step the generator with the value it's awaiting
        try {
          var itr = g.next(awv)
        } catch (err) {
          // the generator threw, reject and all done
          reject(err)
          return
        }

        if (itr.done) {
          // generator returned, resolve and all done
          resolve(itr.value)
          return
        }

        // schedule next step, the value may be a promise tho
        setImmediate(itrun, itr.value)
      }

      // synchronously start the generator
      itrun(undefined)
    })

  }

  constructor() {
    this.HIGH_WATER_MARK_OBJ = 1000
    this.LOW_WATER_MARK_OBJ = 800
    this.transport = null
    this._objQueue = []
    this._objWaiters = []
    this._taskQueue = []
  }

  _objReceived(obj) {
    if (this._objWaiters.length > 0) {
      var [resolve,reject] = this._objWaiters.shift()
      resolve(obj)
    }
    this._objQueue.push(obj)
    if (this._objQueue.length > this.HIGH_WATER_MARK_OBJ) {
      this.transport.pause()
    }
  }

  receiveObj() {
    if (this._objQueue.length > 0) {
      var qh = this._objQueue.shift()
      if (this.transport.paused && this._objQueue.length <= this.LOW_WATER_MARK_OBJ) {
        this.transport.resume()
      }
      return P.resolve(qh)
    }
    if (this.transport.paused)
      this.transport.resume()
    return new P((resolve, reject)=> {
      this._objWaiters.push([resolve, reject])
    })
  }

  sendObj(obj) {
    return new P((resolve, reject)=> {

    })
  }

  /**
   * run a generator as a coroutine
   *
   * @param g a generator
   */
  corun(g) {

    if (!g || 'function' !== typeof g.next || 'function' !== typeof g.throw) {
      throw new Error('one generator is expected')
    }

    return this._scheduleTask((resolve, reject)=> {

      // this function drives the generator one step further
      const itrun = (err, awv, depth = 0)=> {
        while (true) {

          if (err) {
            try {
              var itr = g.throw(err)
              // to here, the generator handled the err
              if (itr.done) {
                // the generator returned, resolve and all done
                resolve(itr.value)
                return
              } else {
                // the generator continued, step it later
                err = null
                awv = itr.value
              }
            } catch (gerr) {
              // the generator threw, reject and all done
              reject(gerr)
              return
            }
          }

          if (awv && 'function' === typeof awv.then) {
            // a promise yielded from the generator, interpret as to awaited it, chain to its resolution
            awv.then((rv)=> {
              setImmediate(itrun, null, rv, depth + 1)
            }, (err)=> {
              // if the awaited promise rejects, propagate the err to generator
              setImmediate(itrun, err, undefined, depth + 1)
            })
            return
          }

          if (depth <= 0) {
            // direct value yielded by the generator has some special treatment

            if (undefined === awv) {
              // bare yield from the generator is interpreted as retrieving next object from the wire
              this.receiveObj().then((obj)=> {
                setImmediate(itrun, null, obj, 1)
              }, (err)=> {
                setImmediate(itrun, err, undefined, 1)
              })
              return
            }

            // other object yielded from generator is interpreted as sending the object over wire
            this.sendObj(awv).then((sentObj)=> {
              // propagate the sent result to the generator as indirect value
              setImmediate(itrun, null, sentObj, 1)
            }, (err)=> {
              // sending failure is propagated to the generator
              setImmediate(itrun, err, undefined, 1)
            })
            return

          } else {
            // at deeper levels, as a non-promise value got here, the depth is decreased

            depth--

          }

          // step the generator with the value it's awaiting
          try {
            var itr = g.next(awv)
          } catch (err) {
            // the generator threw, reject and all done
            reject(err)
            return
          }

          if (itr.done) {
            // generator returned, resolve and all done
            resolve(itr.value)
            return
          }

          // continue stepping the generator, this is mostly looping in deeper promise resolution
          awv = itr.value

        }
      }

      // synchronously start the generator
      itrun(null)

    })
  }

  _scheduleTask(coTask) {

    // this._taskQueue[0] is always the current task as launched promise, trailing ones are queued but not launched
    if (this._taskQueue.length > 0) {
      return new P((resolve, reject)=> {
        this._taskQueue.push([coTask, resolve, reject])
      })
    }

    // this is the function to be installed as current task's finally() handler
    const finishCurrTask = ()=> {
      if (this._taskQueue.length <= 0) {
        // cancellation happened
        return
      }

      var ta = this._taskQueue.shift()
      if (Array.isArray(ta)) { // some lucky tasks are not queued, it's a single promise as queue head for their cases
        if (ta[0].isPending()) {
          // head pending settlement, this can happen after cancellation
          return
        }
        // propagate to the promise created at time queued,
        ta[0].then(ta[1], ta[2])
      }

      if (ta.isPending()) {
        // head pending settlement, this can happen after cancellation
        return
      }

      // check if queue empty
      if (this._taskQueue.length < 1)
        return

      // launch next task by creating its promise
      var ta = this._taskQueue[0]
      ta[0] = new P(ta[0]).finally(finishCurrTask)
    }

    // this is the lucky task to be a fresh head of the queue
    var p = new P(coTask)
    this._taskQueue.push(p.finally(finishCurrTask))
    return p
  }

  cancelAllTasks(err) {
    if (this._taskQueue.length < 1) return

    if (!err) err = new Error('canceled')

    // the first task had already been launched, just remove it
    this._taskQueue.shift()

    // if any else in queue, call the reject handler of promise created at time queued
    for (var [t,resolve,reject] of this._taskQueue) {
      rejectc(err)
    }
    this._taskQueue.clear()
  }

}


// in data vender

function* feedData({freq, from, to, secus, fields = ['open', 'high', 'low', 'close', 'volume']}) {
  var tsaa = [['2015/01/03', '2015/01/04'], ['2015/01/05', '2015/01/06'], ['2015/01/07', '2015/01/08']]
  var segs = [{}, {}, {}]
  yield {numSegs: tsaa.length}
  for (let i = 0; i < tsaa.length; i++) {
    yield [tsaa[i], segs[i]]
  }
  return 'fin'
}


// in data consumer

function* backtest(from, to) {
  var vender1d = {}
  var vender1m = {}
  var allSecus = []

  yield vender1d.corun({
    peerRun: hbi.lit`feedData({freq='1d',from=${from},to=${to},allSecus)`,
    guide: function*({numSegs}) {
      for (let i = 0; i < numSegs; i++) {
        var [tsa,seg] = yield
        // filter with 1d data
        for (let tsi = 1; tsi < tsa.length; tsi++) {
          var ts0 = tsa[tsi - 1]
          var ts = tsa[tsi]
          var top10 = seg.secus.slice(0, 10)
          yield vender1m.corun({
            peerRun: hbi.lit`feedData({freq='1m',from=${ts0.substr(0, 10)},to=${ts.substr(0, 10)},${top10})`,
            guide: function*({numSegs}) {
              for (let i = 0; i < numSegs; i++) {
                var [tsa,seg] = yield
                // trade with 1m data
              }
              return 'fin'
            }
          })
        }
      }
      return 'fin'
    }
  })

}


HBIC.promise(backtest('2015', '2016'))

