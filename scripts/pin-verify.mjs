// pin-verify.mjs — trustlessly verify which relays hold the COMPLETE app drive.
// Uses the v0.20.0 verifySeeded (downloads full drive + checks relay advertised length).
//   node scripts/pin-verify.mjs <driveKeyHex>
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import { HiveRelayClient } from 'p2p-hiverelay-client'

const DRIVE_KEY = process.argv[2]
if (!DRIVE_KEY) { console.error('usage: pin-verify.mjs <driveKeyHex>'); process.exit(1) }
const t = () => new Date().toISOString().slice(11, 19)

const store = new Corestore('./.pin-verify-storage')
await store.ready()
const swarm = new Hyperswarm()
swarm.on('connection', (c) => store.replicate(c))
const relay = new HiveRelayClient({ swarm, store })
await relay.start()
console.log(`[${t()}] started; waiting for relay discovery…`)
await new Promise((r) => setTimeout(r, 14000))

const relays = relay.getRelays()
console.log(`[${t()}] connected relays: ${relays.length}`)

let complete = 0
for (const r of relays) {
  const pk = r.pubkey || r.publicKey || r
  const hex = typeof pk === 'string' ? pk : Buffer.from(pk).toString('hex')
  try {
    const v = await relay.verifySeeded(DRIVE_KEY, { relay: hex, timeout: 90_000 })
    if (v.complete) complete++
    console.log(`[${t()}] ${hex.slice(0, 16)}  complete=${v.complete}  relayFullLen=${v.relayHasFullLength}  contentVerified=${v.contentVerified}  remoteLen=${v.relayRemoteLength}/${v.metaLength}`)
  } catch (e) {
    console.log(`[${t()}] ${hex.slice(0, 16)}  verify-error: ${e.message}`)
  }
}
console.log(`[${t()}] DONE — ${complete}/${relays.length} relays hold the COMPLETE drive`)
await swarm.destroy(); await store.close(); process.exit(0)
