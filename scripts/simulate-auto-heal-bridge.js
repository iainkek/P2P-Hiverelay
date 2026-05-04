#!/usr/bin/env node
/**
 * AutoHeal ↔ Anchor-Proof Bridge Simulation
 *
 * Exercises the real AutoHeal class against an in-memory simulated network
 * to surface emergent behaviors — convergence speed, malicious-operator
 * resistance, stampede prevention, and proof-fetch overhead.
 *
 * Mocks at the boundary: each simulated relay has a real AutoHeal instance
 * plus a fake `federation.snapshot()` that returns a global world view, a
 * fake `seedApp()` that updates the world, and a fake `fetchProof()` that
 * returns `{ ok: true, proof: { anchored } }` only when the target relay is
 * actually hosting the drive (honest) — otherwise `{ ok: false }`
 * (cryptographically would-be invalid).
 *
 * Run:
 *   node scripts/simulate-auto-heal-bridge.js [scenario]
 *
 * Scenarios:
 *   cold-start          — empty net, one app published, watch convergence
 *   sybil-attack        — N attackers claim same operator/region
 *   liar-attack         — peers claim anchored without valid proofs
 *   churn               — 10%/tick of relays go offline
 *   stampede            — 100 relays simultaneously below threshold
 *   partition-heal      — split-brain heals when partition resolves
 *   all                 — run all scenarios
 */

import { AutoHeal } from '../packages/core/core/auto-heal.js'

// ─── Deterministic RNG for reproducibility ─────────────────────────

function mulberry32 (seed) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = t
    r = Math.imul(r ^ (r >>> 15), r | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

// ─── Simulated World ────────────────────────────────────────────────

const REGIONS = ['NA', 'EU', 'AS', 'OC', 'SA', 'AF']
const OPERATORS = ['op-amazon', 'op-coreweave', 'op-hetzner', 'op-vultr', 'op-fly', 'op-railway', 'op-render', 'op-digitalocean']

class World {
  constructor (rng) {
    this.rng = rng
    this.relays = new Map() // pubkey → { region, operator, url, hosting:Set, online:bool, lying:bool }
    this.partitions = null // null or [Set<pubkey>, Set<pubkey>]
  }

  addRelay (pubkey, opts = {}) {
    this.relays.set(pubkey, {
      pubkey,
      region: opts.region || REGIONS[Math.floor(this.rng() * REGIONS.length)],
      operator: opts.operator || OPERATORS[Math.floor(this.rng() * OPERATORS.length)],
      url: 'https://' + pubkey + '.example',
      hosting: new Set(opts.hosting || []),
      online: opts.online !== false,
      lying: !!opts.lying
    })
  }

  // Snapshot for relay `viewer` — applies partition view if any
  snapshotFor (viewer) {
    const out = []
    for (const [pk, r] of this.relays) {
      if (pk === viewer) continue
      if (!r.online) continue
      // Apply partition: a relay only sees others on its side
      if (this.partitions) {
        const [a, b] = this.partitions
        const myside = a.has(viewer) ? a : (b.has(viewer) ? b : null)
        if (myside && !myside.has(pk)) continue
      }
      const apps = []
      for (const appKey of r.hosting) {
        apps.push({ appKey, durability: 1, anchored: !r.lying || true /* always claim anchored */ })
      }
      // Liars also claim anchored for things they DON'T host
      if (r.lying) {
        // For every appKey hosted anywhere in the network, pretend we have it
        const allApps = new Set()
        for (const r2 of this.relays.values()) for (const a of r2.hosting) allApps.add(a)
        for (const a of allApps) {
          if (!r.hosting.has(a)) apps.push({ appKey: a, durability: 1, anchored: true })
        }
      }
      out.push({ pubkey: pk, region: r.region, url: r.url, operator: r.operator, apps })
    }
    return { peerCatalogs: out }
  }

  // Mock proof fetcher: returns ok only if the target relay is actually hosting the drive
  fetcher () {
    return async (url, appKey, opts) => {
      const pk = url.replace('https://', '').replace('.example', '')
      const r = this.relays.get(pk)
      if (!r) return { ok: false, reason: 'no-such-peer' }
      if (!r.online) return { ok: false, reason: 'fetch-error' }
      if (!r.hosting.has(appKey)) {
        // Liars hit this branch — they claim anchored but cannot produce a valid proof
        return { ok: false, reason: 'bad-signature-cryptographic' }
      }
      return {
        ok: true,
        proof: {
          appKey,
          anchored: true,
          version: 1,
          attestedAt: Date.now(),
          relayPubkey: pk,
          signature: 'simulated-valid-sig'
        },
        fetchedAt: Date.now()
      }
    }
  }
}

// ─── Build a real AutoHeal-driven relay backed by the world ────────

function makeSimRelay (world, pubkey, opts = {}) {
  const meta = world.relays.get(pubkey)
  if (!meta) throw new Error('relay not in world: ' + pubkey)

  const seededApps = []
  const node = {
    config: { regions: [meta.region], operator: meta.operator, autoHeal: { enabled: true } },
    swarm: { keyPair: { publicKey: pubkey } },
    appRegistry: {
      catalog: () => Array.from(meta.hosting).map(appKey => ({
        appKey,
        durability: 1,
        anchored: true,
        region: meta.region
      })),
      has: (appKey) => meta.hosting.has(appKey)
    },
    federation: {
      snapshot: () => world.snapshotFor(pubkey)
    },
    seedApp: async (appKey, opts) => {
      meta.hosting.add(appKey)
      seededApps.push({ appKey, opts })
    },
    _resolveAcceptMode: () => 'open',
    _decideAcceptance: () => 'accept',
    _seededApps: seededApps
  }

  const heal = new AutoHeal(node, {
    tickMs: 60_000,
    verifyProofs: true,
    fetchProof: world.fetcher(),
    proofFreshnessMs: 60 * 60_000,
    maxRecruitsPerTick: opts.maxRecruitsPerTick ?? 2,
    convergence: opts.convergence ?? 1.0, // disable jitter for determinism unless overridden
    random: opts.random ?? world.rng,
    storage: { maxBytes: Number.MAX_SAFE_INTEGER, currentBytes: 0 },
    ...opts.healOpts
  })
  heal._running = true

  return { pubkey, meta, node, heal, seededApps }
}

// ─── Helpers for scenario reporting ────────────────────────────────

function countReplicas (world, appKey) {
  let n = 0
  for (const r of world.relays.values()) {
    if (r.online && r.hosting.has(appKey)) n++
  }
  return n
}

function regionsCovering (world, appKey) {
  const s = new Set()
  for (const r of world.relays.values()) {
    if (r.online && r.hosting.has(appKey)) s.add(r.region)
  }
  return s
}

function operatorsCovering (world, appKey) {
  const s = new Set()
  for (const r of world.relays.values()) {
    if (r.online && r.hosting.has(appKey)) s.add(r.operator)
  }
  return s
}

function fmtSnap (world, appKey) {
  const replicas = countReplicas(world, appKey)
  const regions = regionsCovering(world, appKey)
  const ops = operatorsCovering(world, appKey)
  return `replicas=${replicas} regions=${[...regions].sort().join(',') || '-'} ops=${ops.size}`
}

// ─── Tick driver ───────────────────────────────────────────────────

async function tickAll (relays) {
  for (const r of relays) {
    if (!r.meta.online) continue
    await r.heal._tick()
  }
}

// ─── Scenarios ─────────────────────────────────────────────────────

async function scenarioColdStart () {
  console.log('\n══ Scenario: cold-start ══')
  console.log('20 relays across 6 regions / 8 operators. One app published. Watch convergence to 5/3/3.')

  const world = new World(mulberry32(42))
  for (let i = 0; i < 20; i++) world.addRelay('r' + i)

  // r0 publishes the drive
  world.relays.get('r0').hosting.add('app-cold')

  const relays = []
  for (let i = 0; i < 20; i++) {
    relays.push(makeSimRelay(world, 'r' + i, {
      healOpts: {
        thresholds: { minReplicas: 5, minRegions: 3, minOperators: 3 }
      }
    }))
  }

  let metAtTick = -1
  for (let tick = 1; tick <= 30; tick++) {
    await tickAll(relays)
    const reps = countReplicas(world, 'app-cold')
    const regs = regionsCovering(world, 'app-cold')
    const ops = operatorsCovering(world, 'app-cold')
    if (reps >= 5 && regs.size >= 3 && ops.size >= 3 && metAtTick < 0) metAtTick = tick
    if (tick <= 5 || tick % 5 === 0 || metAtTick === tick) {
      console.log(`  tick ${String(tick).padStart(2)}: ${fmtSnap(world, 'app-cold')}${metAtTick === tick ? ' ◀ THRESHOLD MET' : ''}`)
    }
    if (metAtTick > 0 && tick >= metAtTick + 2) break
  }
  console.log(`→ converged at tick ${metAtTick} ${metAtTick > 0 ? '✓' : '✗ NEVER converged'}`)

  // proof-fetch cost discovery
  let totalProofs = 0
  for (const r of relays) totalProofs += r.heal._proofCache.size
  console.log(`→ total cached proofs across network: ${totalProofs} (avg ${(totalProofs / relays.length).toFixed(1)}/relay)`)

  return { converged: metAtTick > 0, ticks: metAtTick, totalProofs }
}

async function scenarioSybilAttack () {
  console.log('\n══ Scenario: sybil-attack ══')
  console.log('5 honest diverse relays + 50 sybils all on same operator/region. Should diversity defeat them?')

  const world = new World(mulberry32(7))
  // 5 diverse honest relays
  const honest = [
    { pk: 'h0', region: 'NA', operator: 'op-real-a' },
    { pk: 'h1', region: 'EU', operator: 'op-real-b' },
    { pk: 'h2', region: 'AS', operator: 'op-real-c' },
    { pk: 'h3', region: 'SA', operator: 'op-real-d' },
    { pk: 'h4', region: 'OC', operator: 'op-real-e' }
  ]
  for (const h of honest) world.addRelay(h.pk, { region: h.region, operator: h.operator })

  // 50 sybils — same operator, same region
  for (let i = 0; i < 50; i++) {
    world.addRelay('s' + i, { region: 'NA', operator: 'op-sybil' })
  }

  // Honest h0 hosts the drive
  world.relays.get('h0').hosting.add('app-sybil')

  const relays = []
  for (const h of honest) {
    relays.push(makeSimRelay(world, h.pk, {
      healOpts: { thresholds: { minReplicas: 4, minRegions: 4, minOperators: 4 } }
    }))
  }
  for (let i = 0; i < 50; i++) {
    relays.push(makeSimRelay(world, 's' + i, {
      healOpts: { thresholds: { minReplicas: 4, minRegions: 4, minOperators: 4 } }
    }))
  }

  let capSkipsTotal = 0
  for (const r of relays) {
    r.heal.on('recruit-skipped', e => {
      if (e.reason === 'operator-fairshare-cap') capSkipsTotal++
    })
  }

  for (let tick = 1; tick <= 15; tick++) await tickAll(relays)

  let sybilHosts = 0
  let honestHosts = 0
  for (const r of world.relays.values()) {
    if (r.hosting.has('app-sybil')) {
      if (r.operator === 'op-sybil') sybilHosts++
      else honestHosts++
    }
  }
  console.log(`  honest replicas: ${honestHosts} | sybil replicas: ${sybilHosts} | cap-skips: ${capSkipsTotal}`)
  console.log(`  total: ${honestHosts + sybilHosts}, regions: ${regionsCovering(world, 'app-sybil').size}, ops: ${operatorsCovering(world, 'app-sybil').size}`)
  console.log(`→ sybil over-recruitment: ${sybilHosts > 5 ? '✗ over-replicated by sybils' : '✓ diversity bounds sybil cluster'}`)

  return { honestHosts, sybilHosts }
}

async function scenarioLiarAttack () {
  console.log('\n══ Scenario: liar-attack ══')
  console.log('10 honest + 10 liars (claim anchored, fail proof verification). Should liars NOT count.')

  const world = new World(mulberry32(13))
  for (let i = 0; i < 10; i++) world.addRelay('h' + i)
  for (let i = 0; i < 10; i++) {
    world.addRelay('l' + i, { lying: true })
  }
  world.relays.get('h0').hosting.add('app-liar')

  const relays = []
  for (let i = 0; i < 10; i++) {
    relays.push(makeSimRelay(world, 'h' + i, {
      healOpts: { thresholds: { minReplicas: 5, minRegions: 3, minOperators: 3 } }
    }))
  }
  for (let i = 0; i < 10; i++) {
    relays.push(makeSimRelay(world, 'l' + i, {
      healOpts: { thresholds: { minReplicas: 5, minRegions: 3, minOperators: 3 } }
    }))
  }

  // Track proof-failed events
  const proofFailures = new Map() // pubkey -> count
  for (const r of relays) {
    r.heal.on('proof-failed', e => {
      proofFailures.set(e.peerPubkey, (proofFailures.get(e.peerPubkey) || 0) + 1)
    })
  }

  for (let tick = 1; tick <= 20; tick++) {
    await tickAll(relays)
  }

  // Liars should never accumulate the drive — they don't actually seed it
  let liarsHosting = 0
  let honestHosting = 0
  for (const [pk, r] of world.relays) {
    if (r.hosting.has('app-liar')) {
      if (pk.startsWith('l')) liarsHosting++
      else honestHosting++
    }
  }
  let liarsFailedProof = 0
  for (const [pk, n] of proofFailures) {
    if (pk.startsWith('l') && n > 0) liarsFailedProof++
  }
  console.log(`  honest hosting: ${honestHosting} | liars hosting (don't actually serve): ${liarsHosting}`)
  console.log(`  liars caught failing proof: ${liarsFailedProof}/10`)
  console.log(`→ ${liarsFailedProof === 10 ? '✓ all liars detected by proof failure' : `✗ only ${liarsFailedProof}/10 liars detected`}`)

  return { honestHosting, liarsHosting, liarsCaught: liarsFailedProof }
}

async function scenarioChurn () {
  console.log('\n══ Scenario: churn ══')
  console.log('Compare 5%, 10%, 20% per-tick churn. Does AutoHeal recover?')

  const results = {}
  for (const churnRate of [0.02, 0.05, 0.10, 0.20]) {
    const world = new World(mulberry32(99))
    for (let i = 0; i < 30; i++) world.addRelay('r' + i)
    world.relays.get('r0').hosting.add('app-churn')

    const relays = []
    for (let i = 0; i < 30; i++) {
      relays.push(makeSimRelay(world, 'r' + i, {
        healOpts: { thresholds: { minReplicas: 5, minRegions: 3, minOperators: 3 } }
      }))
    }

    let ticksAtThreshold = 0
    let ticksTotal = 0
    let minLive = Infinity
    let totalRecruits = 0
    for (let tick = 1; tick <= 50; tick++) {
      for (const r of world.relays.values()) {
        if (world.rng() < churnRate) r.online = !r.online
      }
      world.relays.get('r0').online = true

      await tickAll(relays)
      const after = relays.reduce((s, r) => s + r.seededApps.length, 0)
      totalRecruits = after

      const reps = countReplicas(world, 'app-churn')
      const regs = regionsCovering(world, 'app-churn')
      const ops = operatorsCovering(world, 'app-churn')
      minLive = Math.min(minLive, reps)
      ticksTotal++
      if (reps >= 5 && regs.size >= 3 && ops.size >= 3) ticksAtThreshold++
    }
    const heldPct = Math.round(100 * ticksAtThreshold / ticksTotal)
    console.log(`  churn=${(churnRate * 100).toFixed(0)}%: held ${heldPct}% of ticks, min live=${minLive}, total recruits=${totalRecruits}`)
    results['churn' + (churnRate * 100).toFixed(0)] = { heldPct, minLive, totalRecruits }
  }
  console.log('→ Watch the held% and minLive trends — recovery rate vs. churn rate')
  return results
}

async function scenarioStampede () {
  console.log('\n══ Scenario: stampede ══')
  console.log('100 relays simultaneously below threshold, jitter ON. Recruitment should NOT all fire same tick.')

  const world = new World(mulberry32(55))
  for (let i = 0; i < 100; i++) world.addRelay('r' + i)
  world.relays.get('r0').hosting.add('app-stampede')

  const relays = []
  for (let i = 0; i < 100; i++) {
    relays.push(makeSimRelay(world, 'r' + i, {
      // Use real jitter — convergence ≈ 2K/N where K = minReplicas, N = network size
      convergence: 0.05, // very low — should defer most recruits
      healOpts: { thresholds: { minReplicas: 5, minRegions: 3, minOperators: 3 } }
    }))
  }

  const recruitsPerTick = []
  let totalRecruits = 0
  let firstThresholdTick = -1
  for (let tick = 1; tick <= 30; tick++) {
    const before = relays.reduce((s, r) => s + r.seededApps.length, 0)
    await tickAll(relays)
    const after = relays.reduce((s, r) => s + r.seededApps.length, 0)
    const delta = after - before
    recruitsPerTick.push(delta)
    totalRecruits = after
    const reps = countReplicas(world, 'app-stampede')
    if (reps >= 5 && firstThresholdTick < 0) firstThresholdTick = tick
  }

  const max = Math.max(...recruitsPerTick)
  const total = totalRecruits
  console.log(`  recruits/tick (first 10): ${recruitsPerTick.slice(0, 10).join(' ')}`)
  console.log(`  peak recruits in single tick: ${max} | total recruits over 30 ticks: ${total}`)
  console.log(`  threshold reached at tick ${firstThresholdTick}`)
  console.log(`→ stampede ${max < 30 ? '✓ avoided' : '✗ peak ≥30/tick'}, over-recruit ${total > 20 ? '✗ wasteful (' + total + ' for need-5)' : '✓ controlled'}`)
  return { peak: max, total, firstThresholdTick }
}

async function scenarioPartitionHeal () {
  console.log('\n══ Scenario: partition-heal ══')
  console.log('Side A = 10 relays in NA only; side B = 10 relays in EU/AS/SA. r0 (NA) publishes.')
  console.log('After partition heals, side A has 5 NA replicas (1 region). Threshold needs 3 regions.')
  console.log('Question: does side B step up post-heal to add region diversity?')

  const world = new World(mulberry32(111))
  // Side A: all NA
  for (let i = 0; i < 10; i++) world.addRelay('r' + i, { region: 'NA', operator: 'op-' + (i % 3) })
  // Side B: spread across EU/AS/SA
  const sideBRegions = ['EU', 'EU', 'EU', 'AS', 'AS', 'AS', 'SA', 'SA', 'OC', 'AF']
  for (let i = 10; i < 20; i++) {
    world.addRelay('r' + i, { region: sideBRegions[i - 10], operator: 'op-b' + (i % 4) })
  }
  world.relays.get('r0').hosting.add('app-partition')

  const sideA = new Set()
  const sideB = new Set()
  for (let i = 0; i < 10; i++) sideA.add('r' + i)
  for (let i = 10; i < 20; i++) sideB.add('r' + i)
  world.partitions = [sideA, sideB]

  const relays = []
  for (let i = 0; i < 20; i++) {
    relays.push(makeSimRelay(world, 'r' + i, {
      healOpts: { thresholds: { minReplicas: 5, minRegions: 3, minOperators: 3 } }
    }))
  }

  for (let tick = 1; tick <= 15; tick++) await tickAll(relays)
  const sideAReplicas = [...sideA].filter(pk => world.relays.get(pk).hosting.has('app-partition')).length
  const sideBReplicas = [...sideB].filter(pk => world.relays.get(pk).hosting.has('app-partition')).length
  console.log(`  PARTITIONED — side A: ${sideAReplicas} (regions: ${[...regionsCovering(world, 'app-partition')].join(',')}), side B: ${sideBReplicas}`)

  world.partitions = null
  let healedTick = -1
  for (let tick = 16; tick <= 50; tick++) {
    await tickAll(relays)
    const sideBNow = [...sideB].filter(pk => world.relays.get(pk).hosting.has('app-partition')).length
    if (sideBNow > 0 && healedTick < 0) healedTick = tick
  }
  const sideBFinal = [...sideB].filter(pk => world.relays.get(pk).hosting.has('app-partition')).length
  const finalRegions = regionsCovering(world, 'app-partition')
  console.log(`  HEALED — side B first recruit at tick ${healedTick}, final side B: ${sideBFinal}, total regions: ${finalRegions.size}`)
  console.log(`→ ${healedTick > 0 ? '✓ region-diversity gap forced cross-side recruitment' : '✗ side B never recruits — region count satisfied locally?'}`)
  return { healedTick, sideBFinal, finalRegions: [...finalRegions] }
}

async function scenarioProofScaling () {
  console.log('\n══ Scenario: proof-scaling ══')
  console.log('Measure proof-fetch cost as N grows. Expecting O(K·R) per tick where K=anchored peers, R=relays.')

  const ns = [10, 25, 50, 100]
  const data = []
  for (const N of ns) {
    const world = new World(mulberry32(N * 7))
    for (let i = 0; i < N; i++) world.addRelay('r' + i)
    // K=5 hosting peers spread across the network
    for (let i = 0; i < 5; i++) world.relays.get('r' + i).hosting.add('app-scale')

    let fetchCount = 0
    const baseFetch = world.fetcher()
    const wrappedFetch = async (url, appKey, opts) => {
      fetchCount++
      return baseFetch(url, appKey, opts)
    }

    const relays = []
    for (let i = 0; i < N; i++) {
      const meta = world.relays.get('r' + i)
      const node = {
        config: { regions: [meta.region], autoHeal: { enabled: true } },
        swarm: { keyPair: { publicKey: 'r' + i } },
        appRegistry: {
          catalog: () => Array.from(meta.hosting).map(appKey => ({ appKey, durability: 1, anchored: true, region: meta.region })),
          has: (appKey) => meta.hosting.has(appKey)
        },
        federation: { snapshot: () => world.snapshotFor('r' + i) },
        seedApp: async (appKey) => meta.hosting.add(appKey),
        _resolveAcceptMode: () => 'open',
        _decideAcceptance: () => 'accept'
      }
      const heal = new AutoHeal(node, {
        tickMs: 60_000,
        verifyProofs: true,
        fetchProof: wrappedFetch,
        proofFreshnessMs: 60 * 60_000,
        thresholds: { minReplicas: 5, minRegions: 3, minOperators: 3 },
        convergence: 1.0
      })
      heal._running = true
      relays.push({ heal, meta })
    }

    fetchCount = 0
    await tickAll(relays.map(r => ({ ...r, meta: r.meta })))
    const tick1Fetches = fetchCount
    fetchCount = 0
    await tickAll(relays.map(r => ({ ...r, meta: r.meta })))
    const tick2Fetches = fetchCount

    data.push({ N, K: 5, tick1: tick1Fetches, tick2: tick2Fetches })
    console.log(`  N=${String(N).padStart(3)}: tick1=${tick1Fetches} fetches, tick2=${tick2Fetches} (cached) — ratio tick1/(K·N)=${(tick1Fetches / (5 * N)).toFixed(2)}`)
  }
  console.log('→ Tick-1 fetches scale ≈ K·(N−1) (each relay fetches each anchored peer\'s proof once)')
  return { data }
}

// ─── Runner ─────────────────────────────────────────────────────────

const SCENARIOS = {
  'cold-start': scenarioColdStart,
  sybil: scenarioSybilAttack,
  liar: scenarioLiarAttack,
  churn: scenarioChurn,
  stampede: scenarioStampede,
  partition: scenarioPartitionHeal,
  scaling: scenarioProofScaling
}

async function main () {
  const which = process.argv[2] || 'all'
  console.log('AutoHeal Bridge Simulation')
  console.log('===========================')

  const results = {}
  if (which === 'all') {
    for (const [name, fn] of Object.entries(SCENARIOS)) {
      results[name] = await fn()
    }
  } else if (SCENARIOS[which]) {
    results[which] = await SCENARIOS[which]()
  } else {
    console.error('Unknown scenario:', which)
    console.error('Available:', Object.keys(SCENARIOS).join(', '), 'or "all"')
    process.exit(1)
  }

  console.log('\n══ SUMMARY ══')
  for (const [name, r] of Object.entries(results)) {
    console.log(`  ${name}:`, JSON.stringify(r))
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
