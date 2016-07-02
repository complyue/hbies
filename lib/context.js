'use strict';

/*

 * points here:

 - use *vm* mechanism to hide env details from hosted *code*

 - for one time, use vm.createContext to create a minimalistic, non-strict context, where use of `with(){}` is allowed

 - that to expose *context* as *this* to hosted *code*, whereas hosted *code* can reference all properties of *context*
 without prefix, even to invoke methods of *context*

 - but global built-ins like *Map*, *Set* even *String*, *Object* is non-equal to outer globals within the new vm scope,
 so these must be overridden for thingies like instanceof to work properly with objects created in crossing scopes

 - note *vm* mechanism hides properties of its context object from outer scope, getting/setting works would better be
 done through the vm.runInContext call

 - compile the $sandboxing$ function with all above set

 - whereas the hosted *code* is eval-ed, prefix it with 'use strict'; to make it less harmful

 - mere this/arguments are used to facilitate context/code passing here, no extraneous variable to pollute scopes

 */

const vm = require('vm')

const $global$ = vm.createContext()
let $goverrides$ = []
for (let gpn of vm.runInContext(`Object.getOwnPropertyNames(this)`, $global$)) {
  if ('eval' === gpn) continue // has to use its own *eval*
  let gpd = Object.getOwnPropertyDescriptor(global, gpn)
  if (!gpd || !gpd.value) continue
  $goverrides$.push([gpn, gpd])
}
vm.runInContext(`(function(){
  for(let [gpn,gpd] of arguments) {
    if(gpd.value === this[gpn]) continue
    Object.defineProperty(this, gpn, gpd)
  }
})`, $global$).apply($global$, $goverrides$)
const $sandboxing$ = vm.runInContext(`(function() {
  with (this) {
    return eval("'use strict';" + Array.prototype.join.call(arguments,'\\n'))
  }
})`, $global$)

function runInContext(code, context) {
  return $sandboxing$.call(context, code)
}


exports.runInContext = runInContext
