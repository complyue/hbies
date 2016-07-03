'use strict';

module.exports = module.exports = {

  HBIC: require('./lib/sockconn'),

  get SWSHBIC() {
    return require('./lib/swsconn')
  }

}

Object.assign(module.exports, require('./lib/constants'))
