#!/usr/bin/env node
// Diagnostic: from inside iad's container, join Drop's discoveryKey
// on a fresh swarm and report what peers we see + how long it takes.
// If iad can't discover fra/syd from inside iad, the issue is
// network-level (DHT discovery from this Fly machine), not code.
// If iad CAN discover them but block-flow still fails, the issue is
// at hypercore replication-session level.

import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'

const DROP_KEY_HEX = 'af8fd7b6e1ceffebaba899aae0bf990d7c0671deaaf08f7eade981c93b1657be'
const DISCOVERY_KEY_HEX = 'e0602bc04cf6b086dd5daf71c4fa29a9d5088a506657ec9e29fc3df7d88e1f57'
const RUN_SECONDS = 30

const startedAt = Date.now()
const peerEvents = []

const swarm = new Hyperswarm()
const dkBuf = b4a.from(DISCOVERY_KEY_HEX, 'hex')

swarm.on('connection', (conn, info) => {
  const remotePub = info.publicKey ? b4a.toString(info.publicKey, 'hex') : 'no-pub'
  peerEvents.push({
    at: Date.now() - startedAt,
    event: 'connect',
    remotePub: remotePub.slice(0, 16) + '...',
    topics: info.topics ? info.topics.map(t => b4a.toString(t, 'hex').slice(0, 16) + '...') : [],
    isClient: info.client,
    isServer: info.server
  })
  conn.on('error', () => {})
  conn.on('close', () => {
    peerEvents.push({
      at: Date.now() - startedAt,
      event: 'close',
      remotePub: remotePub.slice(0, 16) + '...'
    })
  })
})

console.log(`[diag-iad] joining Drop's discoveryKey for ${RUN_SECONDS}s...`)
console.log(`[diag-iad] target appKey: ${DROP_KEY_HEX.slice(0, 16)}...`)
console.log(`[diag-iad] discoveryKey:  ${DISCOVERY_KEY_HEX.slice(0, 16)}...`)

const disc = swarm.join(dkBuf, { server: false, client: true })
await swarm.flush()
console.log(`[diag-iad] swarm flushed @ ${Date.now() - startedAt}ms — peers will appear below as they connect`)

await new Promise(resolve => setTimeout(resolve, RUN_SECONDS * 1000))

console.log()
console.log(`[diag-iad] === ${RUN_SECONDS}s elapsed ===`)
console.log(`[diag-iad] events captured: ${peerEvents.length}`)
for (const e of peerEvents) {
  console.log(`  [${(e.at/1000).toFixed(1)}s] ${e.event} ${e.remotePub}${e.event === 'connect' ? ` (client=${e.isClient} server=${e.isServer})` : ''}`)
}

const connects = peerEvents.filter(e => e.event === 'connect')
const closes = peerEvents.filter(e => e.event === 'close')
const distinctPeers = new Set(connects.map(e => e.remotePub))

console.log()
console.log(`[diag-iad] === SUMMARY ===`)
console.log(`[diag-iad]   distinct peers discovered: ${distinctPeers.size}`)
console.log(`[diag-iad]   total connect events:      ${connects.length}`)
console.log(`[diag-iad]   total close events:        ${closes.length}`)
console.log(`[diag-iad]   currently connected:       ${swarm.connections.size}`)

if (distinctPeers.size === 0) {
  console.log(`[diag-iad] VERDICT: DHT discovery failure — iad cannot find any peer holding Drop's discoveryKey from inside Fly's network`)
} else {
  console.log(`[diag-iad] VERDICT: DHT discovery works — found ${distinctPeers.size} peers; issue must be at hypercore replication-session level`)
}

await swarm.destroy()
process.exit(0)
