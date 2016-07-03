'use strict';

const exports = module.exports = {

  HBIC: require('./lib/sockconn'),

  get SWSHBIC() {
    return require('./lib/swsconn')
  }

}

Object.assign(exports, require('./lib/constants'))
