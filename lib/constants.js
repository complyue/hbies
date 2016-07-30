'use strict';

// HBI event names

exports.PACKET_EVENT = 'hbi-packet'

exports.WIRE_CONN_EVENT = 'hbi-wire-conn'

exports.CONN_ERR_EVENT = 'hbi-conn-err'

exports.WIRE_CLOSE_EVENT = 'hbi-wire-close'

exports.WIRE_ERR_EVENT = 'hbi-wire-err'

exports.LANDING_ERR_EVENT = 'hbi-landing-err'

exports.PEER_ERR_EVENT = 'hbi-peer-err'


// HBI constants

exports.DEFAULT_DISCONNECT_WAIT = 30000


// utility functions

function lit(strs, ...vals) {
  var r = []
  for (let i = 0; i < vals.length; i++) {
    let s = strs[i]
    let v = vals[i]
    r.push(s)
    r.push('(')
    r.push(JSON.stringify(v))
    r.push(')')
  }
  r.push(strs[vals.length])
  return r.join('')
}
exports.lit = lit
