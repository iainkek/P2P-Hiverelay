#!/usr/bin/env node
// scripts/custody-e2e-milkyb.mjs
//
// Atomic-custody E2E test against the milkyb-hiverelay-{fra,iad,syd}
// Fly.io fleet over HTTPS. Mirrors scripts/custody-e2e.js but targets
// the 3 milkyb relays instead of the hardcoded foundation fleet.
//
// Stages (same as custody-e2e.js):
//   1. INTENT   — publisher-signed POST to fra (source)
//   2. SEED     — publisher-signed POST /api/v1/seed to iad + syd
//                 (custodians) with custodyIntentId etc.
//   3. QUORUM   — poll /api/custody/<intentId>/status until receiptCount
//                 >= REPLICAS (relays auto-emit receipts when they
//                 anchor the blind content)
//   4. COMMIT   — publisher-signed POST to fra
//   5. RETIRE   — publisher-signed POST to fra
//   6. STATUS   — cross-relay status snapshot from all 3
//
// Usage:
//   node scripts/custody-e2e-milkyb.mjs
//   node scripts/custody-e2e-milkyb.mjs --size 256kb --quorum-timeout 180

import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import sodium from 'sodium-universal'
import b4a from 'b4a'
import { tmpdir } from 'os'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { randomBytes, createHash } from 'crypto'

import { serializeSeedRequestForSigning } from '../packages/core/core/protocol/seed-request.js'
import {
  createCustodyIntent,
  createCustodyCommit,
  createSourceRetired,
  hashHex
} from '../packages/core/core/custody-signing.js'

const RELAYS = {
  'milkyb-fra': { baseUrl: 'https://milkyb-hiverelay-fra.fly.dev' },
  'milkyb-iad': { baseUrl: 'https://milkyb-hiverelay-iad.fly.dev' },
  'milkyb-syd': { baseUrl: 'https://milkyb-hiverelay-syd.fly.dev' }
}

const args = parseArgs(process.argv.slice(2))
const SOURCE = args.source || 'milkyb-fra'
const CUSTODIANS = (args.custodians ? String(args.custodians).split(',') : ['milkyb-iad', 'milkyb-syd']).map(s => s.trim()).filter(Boolean)
const REPLICAS = Number(args.replicas || 2)
const SIZE_BYTES = parseSize(args.size || '256kb')
const HOLD_SECONDS = Number(args.hold || 0)
const QUORUM_TIMEOUT_S = Number(args['quorum-timeout'] || 180)
const POLL_INTERVAL_MS = 2000
const LABEL = args.label || `milkyb-custody-${Date.now().toString(36)}`
const RETAIN_MINS = args['retain-mins'] != null ? Number(args['retain-mins']) : 60
const RETAIN_UNTIL = RETAIN_MINS > 0 ? Date.now() + RETAIN_MINS * 60 * 1000 : null

if (!RELAYS[SOURCE]) die(`unknown --source: ${SOURCE}. choices: ${Object.keys(RELAYS).join(', ')}`)
for (const c of CUSTODIANS) {
  if (!RELAYS[c]) die(`unknown custodian: ${c}. choices: ${Object.keys(RELAYS).join(', ')}`)
}
if (CUSTODIANS.length < REPLICAS) {
  die(`need at least ${REPLICAS} custodians but only got ${CUSTODIANS.length}`)
}

console.log(`▸ atomic-custody E2E (milkyb fleet) — ${LABEL}`)
console.log(`  source:     ${SOURCE} (${RELAYS[SOURCE].baseUrl})`)
console.log(`  custodians: ${CUSTODIANS.join(', ')}`)
console.log(`  replicas:   ${REPLICAS} (quorum threshold)`)
console.log(`  drive size: ${formatBytes(SIZE_BYTES)}`)
console.log(`  retain:     ${RETAIN_MINS} min (test drives self-expire)`)
console.log()

const timeline = []
const startedAt = Date.now()
function mark (stage, detail = null) {
  const ms = Date.now() - startedAt
  timeline.push({ stage, ms, detail })
  console.log(`  [${formatMs(ms)}]  ${stage.padEnd(14)}  ${detail || ''}`)
}

main().catch(err => {
  console.error('\n✗ FATAL:', err.message)
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'))
  printTimeline()
  process.exit(1)
})

async function main () {
  // ── 0. Publisher keypair + test drive ──────────────────────────────
  const publisherPub = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const publisherSec = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publisherPub, publisherSec)
  const publisherKeypair = { publicKey: publisherPub, secretKey: publisherSec }
  const publisherPubkey = b4a.toString(publisherPub, 'hex')

  const storagePath = join(tmpdir(), `hiverelay-custody-e2e-milkyb-${process.pid}-${Date.now()}`)
  await mkdir(storagePath, { recursive: true })
  const store = new Corestore(storagePath)
  const drive = new Hyperdrive(store)
  await drive.ready()

  const addressKey = b4a.toString(drive.key, 'hex')
  const discoveryKey = b4a.toString(drive.discoveryKey, 'hex')

  // Synthetic "blind" content
  const ciphertext = randomBytes(SIZE_BYTES)
  await drive.put('/sealed/blob.bin', ciphertext)
  const ciphertextHash = createHash('sha256').update(ciphertext).digest('hex')
  const ciphertextRoot = ciphertextHash
  const blindContentId = hashHex({ label: LABEL, ciphertextHash, addressKey })
  const contentVersion = 1
  const driveBytes = SIZE_BYTES

  mark('drive', `key=${addressKey.slice(0, 12)} size=${formatBytes(driveBytes)} discoveryKey=${discoveryKey.slice(0, 12)}`)

  // ── Stage 1: Publish custody-intent to source ──────────────────────
  const intent = createCustodyIntent({
    addressKey,
    blindContentId,
    ciphertextRoot,
    contentVersion,
    requiredReplicas: REPLICAS,
    deadline: Date.now() + 60_000,
    metadataVisibility: 'redacted',
    ...(RETAIN_UNTIL ? { retainUntil: RETAIN_UNTIL } : {})
  }, publisherKeypair)

  const intentId = intent.intentId
  const sourceUrl = RELAYS[SOURCE].baseUrl
  const intentRes = await postJson(`${sourceUrl}/api/v1/custody/intent`, intent)
  if (!intentRes.ok) {
    throw new Error(`intent POST failed: ${intentRes.status} ${truncate(intentRes.body, 200)}`)
  }
  mark('intent', `id=${intentId.slice(0, 12)} → ${SOURCE} ok`)

  // ── Stage 2: Seed-with-custody to custodian relays ─────────────────
  const swarm = new Hyperswarm()
  swarm.on('connection', (conn) => store.replicate(conn))
  swarm.join(drive.discoveryKey, { server: true, client: true })
  await swarm.flush()

  const seedBody = buildSeedBody({
    drive, publisherPub, publisherSec, addressKey, discoveryKey,
    custodyIntentId: intentId, blindContentId, ciphertextRoot, contentVersion,
    label: LABEL, driveBytes, retainUntil: RETAIN_UNTIL
  })

  const seedResults = await Promise.all(CUSTODIANS.map(async (id) => {
    try {
      const res = await postJson(`${RELAYS[id].baseUrl}/api/v1/seed`, seedBody)
      return { id, ok: res.ok, status: res.status, body: res.body }
    } catch (err) {
      return { id, ok: false, error: err.message }
    }
  }))

  const seedAccepted = seedResults.filter(r => r.ok).map(r => r.id)
  const seedRejected = seedResults.filter(r => !r.ok)
  mark('seed', `accepted by ${seedAccepted.length}/${CUSTODIANS.length}: ${seedAccepted.join(', ')}`)
  for (const r of seedRejected) {
    mark('  ✗ seed', `${r.id}: status=${r.status} ${truncate(r.body || r.error, 120)}`)
  }
  if (seedAccepted.length < REPLICAS) {
    throw new Error(`not enough relays accepted seed (${seedAccepted.length} < ${REPLICAS})`)
  }

  // ── Stage 3: Wait for receipt quorum ────────────────────────────────
  const quorumDeadline = Date.now() + QUORUM_TIMEOUT_S * 1000
  let lastReceiptCount = 0
  let quorumReached = false
  while (Date.now() < quorumDeadline && !quorumReached) {
    const status = await getStatus(intentId, sourceUrl)
    if (status && status.receiptCount > lastReceiptCount) {
      mark('  receipt', `count=${status.receiptCount}/${REPLICAS} from ${status.relayQuorum?.map(k => k.slice(0, 12)).join(', ') || '?'}`)
      lastReceiptCount = status.receiptCount
    }
    if (status && status.quorumReached) {
      quorumReached = true
      mark('quorum', `${status.receiptCount} valid receipts`)
      break
    }
    await sleep(POLL_INTERVAL_MS)
  }
  if (!quorumReached) {
    throw new Error(`quorum not reached within ${QUORUM_TIMEOUT_S}s (last receiptCount=${lastReceiptCount}/${REPLICAS})`)
  }

  // ── Stage 4: Commit ─────────────────────────────────────────────────
  const status = await getStatus(intentId, sourceUrl)
  if (!status?.receiptRoot) throw new Error(`status missing receiptRoot`)
  if (!Array.isArray(status.relayQuorum) || status.relayQuorum.length < REPLICAS) {
    throw new Error(`status.relayQuorum has ${status.relayQuorum?.length || 0} entries (need ${REPLICAS})`)
  }
  const commit = createCustodyCommit({
    intentId, addressKey, blindContentId, ciphertextRoot, contentVersion,
    receiptRoot: status.receiptRoot, relayQuorum: status.relayQuorum, nextAuthority: null
  }, publisherKeypair)
  const commitRes = await postJson(`${sourceUrl}/api/v1/custody/${intentId}/commit`, commit)
  if (!commitRes.ok) throw new Error(`commit POST failed: ${commitRes.status} ${truncate(commitRes.body, 200)}`)
  mark('commit', `→ ${SOURCE} ok (quorum=${status.relayQuorum.length})`)

  // ── Stage 5: Source-retired ─────────────────────────────────────────
  const retired = createSourceRetired({
    intentId, addressKey, blindContentId, retiredAtVersion: contentVersion, nextAuthority: null
  }, publisherKeypair)
  const retiredRes = await postJson(`${sourceUrl}/api/v1/custody/${intentId}/source-retired`, retired)
  if (!retiredRes.ok) throw new Error(`source-retired POST failed: ${retiredRes.status} ${truncate(retiredRes.body, 200)}`)
  mark('source-retired', `→ ${SOURCE} ok`)

  // ── Stage 6: Cross-relay status check ──────────────────────────────
  await sleep(3000)
  console.log()
  console.log('  ── cross-relay status check ──')
  let consistent = true
  for (const id of Object.keys(RELAYS)) {
    const s = await getStatus(intentId, RELAYS[id].baseUrl)
    if (!s) {
      console.log(`    ${id.padEnd(14)}  no-status`)
      consistent = false
      continue
    }
    const flags = [
      s.committed ? 'committed' : 'NOT-committed',
      s.sourceRetired ? 'retired' : 'NOT-retired',
      `receipts=${s.receiptCount}`,
      s.proofCount > 0 ? `proofs=${s.proofCount}` : null,
      s.nonServingProofCount > 0 ? `non-serving=${s.nonServingProofCount}` : null
    ].filter(Boolean).join(' · ')
    const verdict = (s.committed && s.sourceRetired) ? '✓' : '·'
    console.log(`    ${verdict} ${id.padEnd(14)}  ${flags}`)
    if (!s.committed || !s.sourceRetired) consistent = false
  }
  console.log()
  mark(consistent ? 'verify-pass' : 'verify-partial', consistent ? 'all relays consistent' : 'some relays not yet propagated')

  if (HOLD_SECONDS > 0) {
    console.log(`\n  holding drive open ${HOLD_SECONDS}s for observer proofs...`)
    await sleep(HOLD_SECONDS * 1000)
  }

  try { await swarm.destroy() } catch (_) {}
  try { await drive.close() } catch (_) {}
  try { await store.close() } catch (_) {}
  try { await rm(storagePath, { recursive: true, force: true }) } catch (_) {}

  printTimeline()
  console.log('\n✓ atomic-custody E2E passed against milkyb fleet')
}

// ── Helpers (mirror custody-e2e.js) ────────────────────────────────────

function buildSeedBody (o) {
  const replicationFactor = 3
  const maxStorageBytes = Math.max(o.driveBytes * 4, 64 * 1024 * 1024)
  const ttlSeconds = 30 * 24 * 3600
  const revocable = true
  const durability = 0
  const unseedFreezeMs = 0
  const bountyRate = 0

  const sigMsg = {
    appKey: o.drive.key,
    discoveryKeys: [o.drive.discoveryKey],
    replicationFactor, maxStorageBytes, ttlSeconds, bountyRate,
    revocable, unseedFreezeMs, durability,
    publisherPubkey: o.publisherPub
  }
  const toSign = serializeSeedRequestForSigning(sigMsg)
  const signature = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(signature, toSign, o.publisherSec)

  return {
    appKey: o.addressKey,
    discoveryKeys: [o.discoveryKey],
    replicationFactor, maxStorageBytes, ttlSeconds, bountyRate,
    revocable, unseedFreezeMs, durability,
    publisherPubkey: b4a.toString(o.publisherPub, 'hex'),
    publisherSignature: b4a.toString(signature, 'hex'),
    name: o.label,
    description: `Custody E2E test drive (milkyb fleet)`,
    version: '1.0.0',
    type: 'app',
    privacyTier: 'p2p-only',
    blind: true,
    ...(o.retainUntil ? { retainUntil: o.retainUntil } : {}),
    custodyIntentId: o.custodyIntentId,
    blindContentId: o.blindContentId,
    ciphertextRoot: o.ciphertextRoot
  }
}

async function postJson (url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  })
  const text = await res.text()
  return { ok: res.ok, status: res.status, body: text }
}

async function getStatus (intentId, baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/custody/${intentId}/status`, {
      signal: AbortSignal.timeout(8_000)
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function printTimeline () {
  console.log('\n  ── timeline ──')
  for (const t of timeline) {
    console.log(`    [${formatMs(t.ms)}]  ${t.stage.padEnd(14)}  ${t.detail || ''}`)
  }
}

function formatMs (ms) { return (ms / 1000).toFixed(2).padStart(7) + 's' }
function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { out[k] = next; i++ } else { out[k] = true }
    }
  }
  return out
}
function parseSize (s) {
  const m = String(s).toLowerCase().match(/^(\d+)\s*([kmg]?)b?$/)
  if (!m) throw new Error(`bad --size: ${s}`)
  const n = Number(m[1])
  const mul = { '': 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[m[2]]
  return n * mul
}
function formatBytes (n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}
function truncate (s, n) {
  if (!s) return ''
  s = String(s)
  return s.length > n ? s.slice(0, n) + '…' : s
}
function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }
function die (msg) { console.error('  ✗', msg); process.exit(1) }
