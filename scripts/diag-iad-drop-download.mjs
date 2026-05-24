#!/usr/bin/env node
// From inside iad, try to actually DOWNLOAD Drop's content using a
// fresh corestore + swarm. This isolates whether hyperdrive
// replication works from iad's network at all, vs whether the bug
// is in iad's main relay process state.

import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import { tmpdir } from 'os'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'

const DROP_KEY_HEX = 'af8fd7b6e1ceffebaba899aae0bf990d7c0671deaaf08f7eade981c93b1657be'
const RUN_SECONDS = 45

const storePath = join(tmpdir(), `iad-drop-diag-${Date.now()}`)
await mkdir(storePath, { recursive: true })
const store = new Corestore(storePath)
await store.ready()

const swarm = new Hyperswarm()
swarm.on('connection', (conn) => store.replicate(conn))

const drive = new Hyperdrive(store, b4a.from(DROP_KEY_HEX, 'hex'))
await drive.ready()

console.log(`[diag-download] joining swarm for Drop`)
const done = drive.findingPeers()
swarm.join(drive.discoveryKey, { server: false, client: true })
swarm.flush().then(() => done())

const t0 = Date.now()
let lastMetaLen = 0
let lastBlobLen = 0
let lastBlobContig = 0

const interval = setInterval(async () => {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  const metaLen = drive.db.core.length
  let blobLen = 0
  let blobContig = 0
  try {
    const blobs = await drive.getBlobs()
    if (blobs?.core) {
      blobLen = blobs.core.length
      blobContig = blobs.core.contiguousLength
    }
  } catch (_) {}

  if (metaLen !== lastMetaLen || blobLen !== lastBlobLen || blobContig !== lastBlobContig) {
    console.log(`[diag-download] ${elapsed}s  meta.length=${metaLen}  blob.length=${blobLen}  blob.contiguous=${blobContig}  peers=${swarm.connections.size}`)
    lastMetaLen = metaLen
    lastBlobLen = blobLen
    lastBlobContig = blobContig
  }
}, 1000)

// Try a one-shot update + download
console.log(`[diag-download] running drive.update({wait:true, timeout:30000})...`)
try {
  await drive.update({ wait: true })
  console.log(`[diag-download] update done. meta.length=${drive.db.core.length}`)
} catch (err) {
  console.log(`[diag-download] update failed: ${err.message}`)
}

console.log(`[diag-download] running drive.download('/', { timeout: ${RUN_SECONDS - 5}s })...`)
try {
  const dl = drive.download('/')
  await Promise.race([
    dl.done(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('download timeout')), (RUN_SECONDS - 5) * 1000))
  ])
  console.log(`[diag-download] download done`)
} catch (err) {
  console.log(`[diag-download] download incomplete: ${err.message}`)
}

clearInterval(interval)

const blobs = await drive.getBlobs().catch(() => null)
console.log()
console.log(`[diag-download] === FINAL STATE ===`)
console.log(`[diag-download]   drive.version:          ${drive.version}`)
console.log(`[diag-download]   meta core length:       ${drive.db.core.length}`)
console.log(`[diag-download]   meta core contiguous:   ${drive.db.core.contiguousLength}`)
console.log(`[diag-download]   blob core length:       ${blobs?.core?.length ?? 'n/a'}`)
console.log(`[diag-download]   blob core contiguous:   ${blobs?.core?.contiguousLength ?? 'n/a'}`)
console.log(`[diag-download]   swarm connections:      ${swarm.connections.size}`)

// Try fetching the same files probe-deep tested
console.log()
console.log(`[diag-download] === FILE FETCH TEST ===`)
for (const path of ['/package.json', '/CHANGELOG.md', '/app/lib/escrow/sender.js']) {
  const t = Date.now()
  try {
    const buf = await Promise.race([
      drive.get(path),
      new Promise((_, r) => setTimeout(() => r(new Error('5s timeout')), 5000))
    ])
    console.log(`  ${path}: ${buf ? buf.length + 'B' : 'null'} in ${Date.now() - t}ms`)
  } catch (err) {
    console.log(`  ${path}: FAIL — ${err.message}`)
  }
}

try { await swarm.destroy() } catch {}
try { await drive.close() } catch {}
try { await store.close() } catch {}
try { await rm(storePath, { recursive: true, force: true }) } catch {}
process.exit(0)
