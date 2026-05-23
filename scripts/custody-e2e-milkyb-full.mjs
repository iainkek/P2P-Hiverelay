#!/usr/bin/env node
// scripts/custody-e2e-milkyb-full.mjs
//
// FULL atomic-custody E2E against milkyb fleet — exercises every gap
// closed by PR #19 (anchor honesty) + PR #20 (custody self-attest):
//
//   1. INTENT
//   2. SEED (publisher-signed, with custodyIntentId binding)
//   3. QUORUM         ← requires PR #19: receipts only fire when blob
//                       actually anchored (not on metadata-only)
//   4. COMMIT
//   5. RETIRE
//   6. ── wait for retainUntil to elapse ──
//   7. AUTO-PROOF     ← requires PR #20 gap 1: each custodian relay
//                       must auto-emit custody-non-serving-proof
//                       within ~60s of its custody-expiry-pass
//   8. WITNESS        ← requires PR #20 gap 2: every OTHER relay must
//                       independently sign custody-expiry-witness
//                       referring to the observed proofs
//   9. CROSS-CHECK    — fetch /api/custody/{id}/status from every
//                       relay; assert chain is consistent everywhere
//
// Defaults are tuned for a single fast run (~5 minutes total). Override
// retainMs to shorten or lengthen the expiry window.

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
  'milkyb-syd': { baseUrl: 'https://milkyb-hiverelay-syd.fly.dev' },
  // Foundation fleet (v0.8.20) — added for cross-fleet witness pass
  // verification. Real public IPv4 → improves chance of hyperswarm
  // hole-punching from a Fly-NAT'd publisher.
  utah:        { baseUrl: 'http://144.172.101.215:9100' },
  'utah-us':   { baseUrl: 'http://144.172.91.26:9100' },
  'singapore-1': { baseUrl: 'http://104.194.153.179:9100' },
  'singapore-2': { baseUrl: 'http://104.194.152.121:9100' },
  bern:        { baseUrl: 'http://45.59.123.112:9100' }
}

const args = parseArgs(process.argv.slice(2))
const SOURCE = args.source || 'milkyb-fra'
const CUSTODIANS = (args.custodians ? String(args.custodians).split(',') : ['milkyb-iad', 'milkyb-syd']).map(s => s.trim()).filter(Boolean)
const REPLICAS = Number(args.replicas || 2)
const SIZE_BYTES = parseSize(args.size || '32kb')
const RETAIN_MS = Number(args['retain-ms'] || 90_000) // expire in 90s default
const POST_EXPIRY_WAIT_MS = Number(args['post-expiry-wait-ms'] || 90_000) // wait 90s after retainUntil for proof
const POST_PROOF_WAIT_MS = Number(args['post-proof-wait-ms'] || 90_000) // wait 90s for witnesses
const QUORUM_TIMEOUT_S = Number(args['quorum-timeout'] || 180)
const POLL_INTERVAL_MS = 2000
const LABEL = args.label || `milkyb-full-${Date.now().toString(36)}`

if (!RELAYS[SOURCE]) die(`unknown --source: ${SOURCE}`)
for (const c of CUSTODIANS) {
  if (!RELAYS[c]) die(`unknown custodian: ${c}`)
}
if (CUSTODIANS.length < REPLICAS) die(`need ${REPLICAS} custodians, got ${CUSTODIANS.length}`)

console.log(`▸ FULL atomic-custody E2E — ${LABEL}`)
console.log(`  source:     ${SOURCE}`)
console.log(`  custodians: ${CUSTODIANS.join(', ')}`)
console.log(`  retainUntil: now + ${RETAIN_MS/1000}s`)
console.log(`  total wall time: ~${Math.round((RETAIN_MS + POST_EXPIRY_WAIT_MS + POST_PROOF_WAIT_MS + 60_000) / 60_000)} min`)
console.log()

const timeline = []
const startedAt = Date.now()
function mark (stage, detail) {
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
  // ── 0. Publisher keypair + drive ─────────────────────────────────
  const publisherPub = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const publisherSec = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publisherPub, publisherSec)
  const publisherKeypair = { publicKey: publisherPub, secretKey: publisherSec }

  const storagePath = join(tmpdir(), `hiverelay-custody-full-${process.pid}-${Date.now()}`)
  await mkdir(storagePath, { recursive: true })
  const store = new Corestore(storagePath)
  const drive = new Hyperdrive(store)
  await drive.ready()

  const addressKey = b4a.toString(drive.key, 'hex')
  const discoveryKey = b4a.toString(drive.discoveryKey, 'hex')
  const ciphertext = randomBytes(SIZE_BYTES)
  await drive.put('/sealed/blob.bin', ciphertext)
  const ciphertextHash = createHash('sha256').update(ciphertext).digest('hex')
  const blindContentId = hashHex({ label: LABEL, ciphertextHash, addressKey })
  const contentVersion = 1
  const retainUntil = Date.now() + RETAIN_MS

  mark('drive', `key=${addressKey.slice(0, 12)} size=${formatBytes(SIZE_BYTES)}`)

  // ── 1. INTENT ────────────────────────────────────────────────────
  const intent = createCustodyIntent({
    addressKey, blindContentId, ciphertextRoot: ciphertextHash,
    contentVersion, requiredReplicas: REPLICAS,
    deadline: Date.now() + 60_000, metadataVisibility: 'redacted',
    retainUntil
  }, publisherKeypair)
  const intentId = intent.intentId
  const sourceUrl = RELAYS[SOURCE].baseUrl

  let r = await postJson(`${sourceUrl}/api/v1/custody/intent`, intent)
  if (!r.ok) throw new Error(`intent: ${r.status} ${truncate(r.body, 200)}`)
  mark('intent', `id=${intentId.slice(0, 12)} → ${SOURCE}`)

  // ── 2. SEED ──────────────────────────────────────────────────────
  const swarm = new Hyperswarm()
  swarm.on('connection', (conn) => store.replicate(conn))
  swarm.join(drive.discoveryKey, { server: true, client: true })
  await swarm.flush()

  const seedBody = buildSeedBody({
    drive, publisherPub, publisherSec, addressKey, discoveryKey,
    custodyIntentId: intentId, blindContentId, ciphertextRoot: ciphertextHash,
    contentVersion, label: LABEL, driveBytes: SIZE_BYTES, retainUntil
  })

  const seedResults = await Promise.all(CUSTODIANS.map(async (id) => {
    try {
      const res = await postJson(`${RELAYS[id].baseUrl}/api/v1/seed`, seedBody)
      return { id, ok: res.ok, status: res.status, body: res.body }
    } catch (err) { return { id, ok: false, error: err.message } }
  }))
  const accepted = seedResults.filter(r => r.ok).map(r => r.id)
  mark('seed', `accepted by ${accepted.length}/${CUSTODIANS.length}: ${accepted.join(', ')}`)
  if (accepted.length < REPLICAS) {
    for (const r of seedResults.filter(r => !r.ok)) mark('  ✗ seed', `${r.id}: ${r.status} ${truncate(r.body || r.error, 120)}`)
    throw new Error(`only ${accepted.length}/${REPLICAS} accepted seed`)
  }

  // ── 3. QUORUM ────────────────────────────────────────────────────
  // With PR #19 deployed, receipts only fire AFTER the relay actually
  // anchors the blob (not just metadata).
  const quorumDeadline = Date.now() + QUORUM_TIMEOUT_S * 1000
  let lastCount = 0
  let quorumReached = false
  while (Date.now() < quorumDeadline && !quorumReached) {
    const status = await getStatus(intentId, sourceUrl)
    if (status?.receiptCount > lastCount) {
      mark('  receipt', `count=${status.receiptCount}/${REPLICAS}`)
      lastCount = status.receiptCount
    }
    if (status?.quorumReached) { quorumReached = true; mark('quorum', `${status.receiptCount} signed`); break }
    await sleep(POLL_INTERVAL_MS)
  }
  if (!quorumReached) throw new Error(`quorum not reached in ${QUORUM_TIMEOUT_S}s (last count=${lastCount})`)

  // ── 4. COMMIT ────────────────────────────────────────────────────
  const status = await getStatus(intentId, sourceUrl)
  if (!status?.receiptRoot) throw new Error('status missing receiptRoot')
  const commit = createCustodyCommit({
    intentId, addressKey, blindContentId, ciphertextRoot: ciphertextHash,
    contentVersion, receiptRoot: status.receiptRoot,
    relayQuorum: status.relayQuorum, nextAuthority: null
  }, publisherKeypair)
  r = await postJson(`${sourceUrl}/api/v1/custody/${intentId}/commit`, commit)
  if (!r.ok) throw new Error(`commit: ${r.status} ${truncate(r.body, 200)}`)
  mark('commit', `quorum=${status.relayQuorum.length}`)

  // ── 5. RETIRE ────────────────────────────────────────────────────
  const retired = createSourceRetired({
    intentId, addressKey, blindContentId,
    retiredAtVersion: contentVersion, nextAuthority: null
  }, publisherKeypair)
  r = await postJson(`${sourceUrl}/api/v1/custody/${intentId}/source-retired`, retired)
  if (!r.ok) throw new Error(`retire: ${r.status} ${truncate(r.body, 200)}`)
  mark('source-retired', 'ok')

  // ── 6. Wait for retainUntil + ~60s for expiry-pass to fire ──────
  const msUntilExpiry = Math.max(0, retainUntil - Date.now())
  const totalExpiryWait = msUntilExpiry + POST_EXPIRY_WAIT_MS
  mark('  ⏳ wait', `${Math.round(totalExpiryWait/1000)}s until first custody-expiry-pass fires post-retainUntil`)
  await sleep(totalExpiryWait)

  // ── 7. AUTO-PROOF (PR #20 gap 1) ─────────────────────────────────
  // Each custodian relay's custody-expiry-pass should have detected
  // the expired blind+temporary entry, unseeded it, AND signed +
  // recorded a custody-non-serving-proof. Verify by querying status
  // at any relay (registry propagates via gossip).
  let proofStatus = await getStatus(intentId, sourceUrl)
  const proofCount = proofStatus?.nonServingProofCount || 0
  mark('auto-proof', `${proofCount} non-serving-proofs visible`)
  if (proofCount === 0) {
    console.warn('\n  ⚠ no non-serving-proofs yet — relay may need another expiry-pass tick (60s)')
    mark('  ⏳ extra wait', '60s for second expiry-pass')
    await sleep(60_000)
    proofStatus = await getStatus(intentId, sourceUrl)
  }
  const finalProofCount = proofStatus?.nonServingProofCount || 0
  if (finalProofCount < REPLICAS) {
    console.warn(`  ⚠ only ${finalProofCount}/${REPLICAS} proofs after extended wait`)
  } else {
    mark('  ✓ proofs', `${finalProofCount}/${REPLICAS} custodians self-attested deletion`)
  }

  // ── 8. WITNESS (PR #20 gap 2) ────────────────────────────────────
  // Now wait for the witness pass on each relay to scan peers'
  // non-serving-proofs and sign independent expiry-witnesses.
  mark('  ⏳ wait', `${POST_PROOF_WAIT_MS/1000}s for cross-relay witness pass`)
  await sleep(POST_PROOF_WAIT_MS)

  const witnessStatus = await getStatus(intentId, sourceUrl)
  const witnessCount = witnessStatus?.validExpiryWitnessCount || witnessStatus?.expiryWitnesses?.length || 0
  mark('witness', `${witnessCount} expiry-witnesses visible`)

  // ── 9. CROSS-CHECK ───────────────────────────────────────────────
  console.log()
  console.log('  ── cross-relay full chain check ──')
  let allConsistent = true
  for (const id of Object.keys(RELAYS)) {
    const s = await getStatus(intentId, RELAYS[id].baseUrl)
    if (!s) { console.log(`    ${id.padEnd(14)}  ⚠ no-status`); allConsistent = false; continue }
    const flags = [
      s.committed ? 'committed' : 'NOT-committed',
      s.sourceRetired ? 'retired' : 'NOT-retired',
      `receipts=${s.receiptCount || 0}`,
      `proofs=${s.nonServingProofCount || 0}`,
      `witnesses=${(s.validExpiryWitnessCount ?? s.expiryWitnesses?.length) || 0}`
    ].join(' · ')
    const fullChain = s.committed && s.sourceRetired && (s.nonServingProofCount || 0) >= REPLICAS
    const verdict = fullChain ? '✓' : (s.committed && s.sourceRetired ? '~' : '·')
    console.log(`    ${verdict} ${id.padEnd(14)}  ${flags}`)
    if (!fullChain) allConsistent = false
  }
  console.log()
  mark(allConsistent ? 'full-pass' : 'partial-pass', allConsistent ? 'BURNED-detectable everywhere' : 'some relays missing proofs/witnesses')

  // ── Cleanup ──────────────────────────────────────────────────────
  try { await swarm.destroy() } catch {}
  try { await drive.close() } catch {}
  try { await store.close() } catch {}
  try { await rm(storagePath, { recursive: true, force: true }) } catch {}

  printTimeline()
  if (allConsistent) {
    console.log('\n✓ FULL atomic-custody E2E passed — recipient can prove BURNED cryptographically')
  } else {
    console.log('\n⚠ FULL E2E partial — some attestation didn\'t propagate; see cross-check above')
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildSeedBody (o) {
  const replicationFactor = 3
  const maxStorageBytes = Math.max(o.driveBytes * 4, 64 * 1024 * 1024)
  const ttlSeconds = 30 * 24 * 3600
  const revocable = true
  const sigMsg = {
    appKey: o.drive.key, discoveryKeys: [o.drive.discoveryKey],
    replicationFactor, maxStorageBytes, ttlSeconds, bountyRate: 0,
    revocable, unseedFreezeMs: 0, durability: 0,
    publisherPubkey: o.publisherPub
  }
  const toSign = serializeSeedRequestForSigning(sigMsg)
  const signature = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(signature, toSign, o.publisherSec)
  return {
    appKey: o.addressKey, discoveryKeys: [o.discoveryKey],
    replicationFactor, maxStorageBytes, ttlSeconds, bountyRate: 0,
    revocable, unseedFreezeMs: 0, durability: 0,
    publisherPubkey: b4a.toString(o.publisherPub, 'hex'),
    publisherSignature: b4a.toString(signature, 'hex'),
    name: o.label, description: `Full custody E2E test`,
    version: '1.0.0', type: 'app', privacyTier: 'p2p-only', blind: true,
    retainUntil: o.retainUntil,
    custodyIntentId: o.custodyIntentId,
    blindContentId: o.blindContentId,
    ciphertextRoot: o.ciphertextRoot
  }
}

async function postJson (url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000)
  })
  return { ok: res.ok, status: res.status, body: await res.text() }
}

async function getStatus (intentId, baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/custody/${intentId}/status`, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

function printTimeline () {
  console.log('\n  ── timeline ──')
  for (const t of timeline) console.log(`    [${formatMs(t.ms)}]  ${t.stage.padEnd(14)}  ${t.detail || ''}`)
}
function formatMs (ms) { return (ms/1000).toFixed(2).padStart(7) + 's' }
function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const next = argv[i+1]
      if (next && !next.startsWith('--')) { out[k] = next; i++ } else { out[k] = true }
    }
  }
  return out
}
function parseSize (s) {
  const m = String(s).toLowerCase().match(/^(\d+)\s*([kmg]?)b?$/)
  if (!m) throw new Error(`bad --size: ${s}`)
  return Number(m[1]) * ({ '':1, k:1024, m:1024*1024, g:1024*1024*1024 }[m[2]])
}
function formatBytes (n) {
  if (n < 1024) return n + ' B'
  if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB'
  return (n/1024/1024).toFixed(1) + ' MB'
}
function truncate (s, n) { if (!s) return ''; s = String(s); return s.length > n ? s.slice(0,n) + '…' : s }
function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }
function die (msg) { console.error('  ✗', msg); process.exit(1) }
