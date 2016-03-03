'use strict';

const CONSTS = require('./lib/constants')

module.exports.PACK_EVENT = CONSTS.HBI_PACK_EVENT
module.exports.WIRE_ERR_EVENT = CONSTS.HBI_WIRE_ERR_EVENT
module.exports.PEER_ERR_EVENT = CONSTS.HBI_PEER_ERR_EVENT
module.exports.LANDING_ERR_EVENT = CONSTS.HBI_LANDING_ERR_EVENT

module.exports.HBIC = require('./lib/conn')
