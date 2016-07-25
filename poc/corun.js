'use strict';

const assert = require('assert')
const net = require('net')

const P = require('bluebird')


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

