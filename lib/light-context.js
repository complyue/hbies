'use strict';

/*

 * points here:

 - for the browser env, *window* is not hidden to hosted *code*, in lacking of mechanisms similar to *vm* in Node.js

 - for one time, use indirect eval to have a non-strict context, where use of `with(){}` is allowed

 - that to expose *context* as *this* to hosted *code*, whereas hosted *code* can reference all properties of *context*
 without prefix, even to invoke methods of *context*

 - compile the $sandboxing$ function with all above set

 - in where direct eval is used to grant the function and with scope to hosted code

 - and as the hosted *code* is eval-ed, prefix it with 'use strict'; for it to behave

 - mere this/arguments are used to facilitate context/code passing here, no extraneous variable to pollute scopes

 */

const $sandboxing$ = (0, eval)(`(function(){
  with(this) {
    return eval("'use strict';" + Array.prototype.join.call(arguments,'\\n'))
  }
})`)

function runInContext(code, context) {
  return $sandboxing$.call(context, code)
}


exports.runInContext = runInContext
