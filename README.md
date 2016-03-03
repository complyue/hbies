# Hosting Based Interfacing

## Example Client:
```javascript

const hbi = require('hbi')

let port = 3321,
    host = '192.168.0.115'
let hbic = new hbi.HBIC({
    console: console,
    os: require('os'),
    told: rhn => console.log(`Ahah, now I know ${host}:${port} is hosted by ${rhn}`)
})
hbic.wire(require('net').connect(port, host))
hbic.send(String.raw `
    console.log("This is a HI from ${os.hostname()}.\nI know you can see you're on host " + os.hostname() + ", but I can't see that!")
    console.log(" umm... unless...")
    sendBack('told(' + JSON.stringify(os.hostname()) + ')')
`)

```

## Example Server:
```javascript

const hbi = require('hbi')

let port = 3321,
    host = '192.168.0.115'

// share a single hbi context for all connected clients
let hbiCtx = {
  // here too many artifacts are exposed, DO NOT do this in real HBI applications
  console: console,
  os: require('os')
}

let svr = require('net').createServer((socket) => {
  let hbic = new hbi.HBIC(hbiCtx)
  hbic.on(hbi.PACK_EVENT, (packet, payload) => {
    console.log('[hbi server got packet of type ', typeof(packet), ']:', packet, '\n[hbi flew code]:', payload)
  })
  hbic.on(hbi.WIRE_ERR_EVENT, (err) => {
    console.log('[hbic wire error in server]:', err.stack || err)
  })
  hbic.on(hbi.PEER_ERR_EVENT, (err) => {
    console.log('[hbi landing error in client side]:', err)
    console.log('[disconnecting hbi] ...')
    hbic.disconnect()
  })
  hbic.on(hbi.LANDING_ERR_EVENT, (err) => {
    console.log('[hbi landing error in server side]:', err.stack || err)
    console.log(' ** normally the situation should be analyzed and avoided **')
    console.log(' ** sending the err as peer err to client now **')
    hbic.sendPeerError(err)
  })
  hbic.wire(socket)
})
svr.on('listening', () => {
  console.log('[hbi server listening]:', host+':'+port)
})
svr.listen(port, host)

```
