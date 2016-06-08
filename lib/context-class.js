'use strict';

const vm = require('vm')


class ContextClass {
  constructor() {

    /*
     augment this object as a vm context, to serve as context/scope of HBI connections.
     */
    vm.createContext(this)

    /*
     override all js built-in artifacts of this context with ones defined in NodeJS' default global,
     or things like instanceof will not work as normally expected by most programmers.
     while HBI code from peers run in this separate context, there're still potential problems in this regard.
     the runInNewContext approach is a simple solution to avoid black/white listing artifacts by ourselves, but use
     what NodeJS' vm module impose
     */
    for (var gpn of  vm.runInNewContext('Object.getOwnPropertyNames(this)')) {
      var gpd = Object.getOwnPropertyDescriptor(global, gpn)
      Object.defineProperty(this, gpn, gpd)
    }

    /*
     bind all class methods to this, thus code from peers don't need to prefix <this.> to calls of any methods
     define by subclasses.
     overrides are expected, so dedup with a Set
     and get function object from <this> to honor native property lookup algorithm
     */
    var pks = new Set()
    pks.add('constructor', 'prototype') // ignore these property keys
    for (var proto = Object.getPrototypeOf(this);
         proto && proto !== Object.prototype;
         proto = Object.getPrototypeOf(proto)) {
      for (var pk of Object.getOwnPropertyNames(proto)) {
        if (pks.has(pk)) continue
        else pks.add(pk)
        var pv = this[pk]
        if (typeof pv === 'function') {
          this[pk] = pv.bind(this)
        }
      }
    }

  }
}


module.exports = ContextClass
