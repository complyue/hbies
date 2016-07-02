'use strict';

if (require.main !== module) {
  throw module.filename + ' always run on its own'
}


/**
 * Hosting Based Interfacing demo

 * the addr is specified by cmdl arg 1,
 * first run will acting as server to listen on it,
 * subsequent runs will connect to the addr and start repl
 */


const hbi = require('.')


let addr = require('process').argv[2]
if (!addr) {
  console.log('Usage: ')
  console.log('  node', module.filename, '<addr>')
  console.log('Examples: ')
  console.log('  node', module.filename, '3321')
  console.log('  node', module.filename, 'hbi.sock')
  console.log('  node', module.filename, '\'({port:3321,host:"127.0.0.1"})\'')
  console.log('  node', module.filename, '\'({path:"hbi.sock"})\'')
  require('process').exit(1)
}
let port = parseInt(addr)
if (isFinite(port)) {
  addr = port
} else if (eval(addr)) {
  addr = eval(addr)
}


(function startServer() {
  // share a single hbi context for all connected clients
  let hbiCtx = {
    // here too many artifacts are exposed, DO NOT do this in real HBI applications
    console: console,
    require: require,
    os: require('os'),
    versions: require('process').versions
  }

  let svr = require('net').createServer((socket) => {
    let hbic = new hbi.HBIC(hbiCtx)
    hbic.on(hbi.PACKET_EVENT, (code) => {
      console.log('[hbi server landed code]:', code)
    })
    hbic.on(hbi.WIRE_ERR_EVENT, (err) => {
      console.log('[hbic wire error in server]:', err.stack || err)
    })
    hbic.on(hbi.WIRE_CLOSE_EVENT, () => {
      console.log('[server hbic wire closed]')
    })
    hbic.on(hbi.PEER_ERR_EVENT, (err) => {
      console.log('[hbi landing error in client side]:', err)
      console.log('[disconnecting client] ...')
      hbic.disconnect()
    })
    hbic.on(hbi.LANDING_ERR_EVENT, (err, code) => {
      console.log('[hbi landing error in server side]:', err.stack || err)
      console.log('[hbi flew code]:', code)
      console.log(' ** normally the situation should be analyzed and avoided **')
      console.log(' ** sending the err as peer err to client now **')
      hbic.sendPeerError(err)
    })
    hbic.wire(socket)
  })
  svr.listen(addr)
  svr.on('listening', () => {
    console.log('[hbi server listening]:', addr)
  })
  svr.on('error', (err) => {
    svr.close()
    svr = null; // release ref
    if (err.code !== 'EADDRINUSE') {
      // real error
      throw err
    }

    // had svr there, act as repl client
    startClient()
  })
})()


function startClient() {
  let replCtx = require('repl').start({
    prompt: 'hbi> '
  }).context

  // use repl's context as client hbi context,
  // reuse among reconnects
  let hbic = new hbi.HBIC(replCtx)
  hbic.on(hbi.PACK_EVENT, (packet, code) => {
    console.log('[hbi client got packet of type ' + typeof(packet) + ']:', packet)
    console.log('[hbi flew code]:', code)
  })
  hbic.on(hbi.WIRE_ERR_EVENT, (err) => {
    console.log('[hbic wire error in client]:', err.stack || err)
  })
  hbic.on(hbi.WIRE_CLOSE_EVENT, () => {
    console.log('[client hbic wire closed]')
  })
  hbic.on(hbi.PEER_ERR_EVENT, (err) => {
    console.log('[hbi landing error in server side]:', err)
    console.log('[hbi reconnecting] ...')
    reconnect()
  })
  hbic.on(hbi.LANDING_ERR_EVENT, (err, code) => {
    replCtx.lastErr = err
    console.log('[hbi landing error in client side]:', err.stack || err)
    console.log('[hbi flew code]:', code)
    console.log(' ** normally the situation should be analyzed and avoided **')
    console.log(' ** since this is a demo, the mass is kept here, while **')
    console.log(' **   hbic.sendPeerError(lastErr)')
    console.log(' ** can be used to send this err as peer err to server, **')
    console.log(' ** then the server will close the wired socket in this demo **')
  })

  function reconnect() {
    hbic.disconnect()
    let socket = require('net').connect(addr, () => {
      console.log('[hbi client connected to]:', addr)
      hbic.wire(socket)
    })
  }

  replCtx.hbic = hbic
  replCtx.send = hbic.send.bind(hbic)
  replCtx.reconnect = reconnect

  reconnect()
}
