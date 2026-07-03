// seed-pear-release.mjs — ask the live HiveRelay network to host (replicate) an
// already-`pear stage`d drive by its key, so the app stays downloadable even when
// the publisher's machine is offline. P2P signed-seed (no HTTP API key).
//
//   node scripts/seed-pear-release.mjs <driveKeyHex> [replicationFactor]

import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import { HiveRelayClient } from 'p2p-hiverelay-client'

const APP_KEY = process.argv[2] || '850929ab0b7f1eb927dd69c6ae057af0a43fba1ced4c33e0df2e7cff0ee92268'
const REPLICATION = Number(process.argv[3] || 6)
const t = () => new Date().toISOString().slice(11, 19)

const store = new Corestore('./.seed-publisher-storage')
await store.ready()
const swarm = new Hyperswarm()
swarm.on('connection', (c) => store.replicate(c))

const relay = new HiveRelayClient({ swarm, store })
relay.on('relay-connected', ({ pubkey }) => console.log(`[${t()}] relay-connected ${String(pubkey).slice(0, 16)}…`))

console.log(`[${t()}] starting client; seeding ${APP_KEY.slice(0, 16)}… replicationFactor=${REPLICATION}`)
await relay.start()

// Give DHT relay discovery a moment to connect.
await new Promise((r) => setTimeout(r, 12000))
const relays = relay.getRelays()
console.log(`[${t()}] connected relays: ${relays.length}`)
for (const r of relays) console.log('   - ' + String(r.pubkey || r.publicKey || JSON.stringify(r)).slice(0, 24))

try {
  const res = await relay.seed(APP_KEY, { replicationFactor: REPLICATION })
  console.log(`[${t()}] seed() sent →`, JSON.stringify(res))
} catch (e) {
  console.log(`[${t()}] seed() error: ${e.message}`)
}

setInterval(() => {
  let mine = 0
  try { mine = relay.getAvailableApps().filter((a) => (a.appKey || '').toLowerCase() === APP_KEY.toLowerCase()).length } catch (_) {}
  console.log(`[${t()}] relays=${relay.getRelays().length} hosting-rows=${mine} conns=${swarm.connections.size}`)
}, 20000)

console.log(`[${t()}] staying online so relays can pull blocks (Ctrl+C to stop)…`)
process.on('SIGINT', async () => { await swarm.destroy(); await store.close(); process.exit(0) })
