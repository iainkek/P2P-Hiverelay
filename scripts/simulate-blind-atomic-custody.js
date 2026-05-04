#!/usr/bin/env node

import { selectQuorum, describeQuorum } from '../packages/core/core/quorum-selector.js'

const DEFAULT_ITERATIONS = 5000
const DEFAULT_SEED = 'hiverelay-blind-atomic-v1'

const SCENARIOS = [
  {
    name: 'mirror-3-score',
    description: '3 full encrypted mirrors, score-biased selection, no expiry witnesses',
    custodyCount: 3,
    receiptQuorum: 2,
    readThreshold: 1,
    selection: 'score',
    fullMirror: true,
    witnessCount: 0
  },
  {
    name: 'mirror-5-diverse',
    description: '5 full encrypted mirrors, operator/region diverse selection, no expiry witnesses',
    custodyCount: 5,
    receiptQuorum: 3,
    readThreshold: 1,
    selection: 'diverse',
    fullMirror: true,
    witnessCount: 0
  },
  {
    name: 'shards-10of16-random',
    description: '16 encrypted shards, 10 needed to recover, random custody relays',
    custodyCount: 16,
    receiptQuorum: 13,
    readThreshold: 10,
    selection: 'random',
    fullMirror: false,
    witnessCount: 0
  },
  {
    name: 'shards-10of16-diverse',
    description: '16 encrypted shards, 10 needed to recover, diverse custody relays',
    custodyCount: 16,
    receiptQuorum: 13,
    readThreshold: 10,
    selection: 'diverse',
    fullMirror: false,
    witnessCount: 0
  },
  {
    name: 'shards-10of16-witness5',
    description: '16 encrypted shards plus 5 independent expiry witnesses',
    custodyCount: 16,
    receiptQuorum: 13,
    readThreshold: 10,
    selection: 'diverse',
    fullMirror: false,
    witnessCount: 5,
    witnessSelection: 'diverse'
  },
  {
    name: 'shards-8of24-witness7',
    description: '24 encrypted shards, 8 needed to recover, 7 independent expiry witnesses',
    custodyCount: 24,
    receiptQuorum: 18,
    readThreshold: 8,
    selection: 'diverse',
    fullMirror: false,
    witnessCount: 7,
    witnessSelection: 'diverse'
  }
]

function simulateScenario (scenario, config) {
  const totals = {
    committed: 0,
    available: 0,
    adversaryReconstructsCiphertext: 0,
    activeServingViolation: 0,
    undetectedActiveServing: 0,
    custodyRegions: 0,
    custodyOperators: 0,
    witnessRegions: 0,
    witnessOperators: 0,
    honestWitnesses: 0
  }

  for (let i = 0; i < config.iterations; i++) {
    const rng = new Rng(hash32(`${config.seed}:${scenario.name}:${i}`))
    const network = makeNetwork(rng, config)
    const custodians = pickRelays(network, scenario.custodyCount, scenario.selection, rng)
    const custodySummary = describeQuorum(custodians)
    totals.custodyRegions += custodySummary.regions.length
    totals.custodyOperators += custodySummary.operators.length

    const receipts = custodians.filter(relay => relayAnchors(relay, rng))
    const committed = receipts.length >= scenario.receiptQuorum
    if (!committed) continue

    totals.committed++
    if (hasEnoughServingRelays(receipts, scenario.readThreshold, rng, config)) totals.available++
    if (adversaryCanReconstruct(receipts, scenario)) totals.adversaryReconstructsCiphertext++

    const violators = receipts.filter(relay => continuesServingAfterExpiry(relay, rng, config))
    if (violators.length === 0) continue
    totals.activeServingViolation++

    const witnesses = pickRelays(network, scenario.witnessCount, scenario.witnessSelection || 'diverse', rng, new Set(custodians.map(r => r.pubkey)))
    const witnessSummary = describeQuorum(witnesses)
    totals.witnessRegions += witnessSummary.regions.length
    totals.witnessOperators += witnessSummary.operators.length

    const honestWitnesses = witnesses.filter(w => !w.malicious)
    totals.honestWitnesses += honestWitnesses.length
    if (!violationDetected(violators, honestWitnesses, rng, config)) totals.undetectedActiveServing++
  }

  const committed = totals.committed || 1
  return {
    name: scenario.name,
    description: scenario.description,
    custodyCount: scenario.custodyCount,
    receiptQuorum: scenario.receiptQuorum,
    readThreshold: scenario.readThreshold,
    witnessCount: scenario.witnessCount,
    commitRate: ratio(totals.committed, config.iterations),
    availabilityAfterSourceStop: ratio(totals.available, committed),
    adversaryReconstructsCiphertext: ratio(totals.adversaryReconstructsCiphertext, committed),
    activeServingViolation: ratio(totals.activeServingViolation, committed),
    undetectedActiveServing: ratio(totals.undetectedActiveServing, committed),
    avgCustodyRegions: round(totals.custodyRegions / config.iterations),
    avgCustodyOperators: round(totals.custodyOperators / config.iterations),
    avgWitnessRegions: scenario.witnessCount ? round(totals.witnessRegions / committed) : 0,
    avgWitnessOperators: scenario.witnessCount ? round(totals.witnessOperators / committed) : 0,
    avgHonestWitnesses: scenario.witnessCount ? round(totals.honestWitnesses / committed) : 0
  }
}

function makeNetwork (rng, config) {
  const maliciousOperators = new Set()
  for (let i = 0; i < config.operatorCount; i++) {
    if (rng.next() < config.maliciousOperatorRate) maliciousOperators.add(`op-${i}`)
  }

  const relays = []
  for (let i = 0; i < config.relayCount; i++) {
    const operatorIndex = weightedOperatorIndex(i, rng, config.operatorCount)
    const operator = `op-${operatorIndex}`
    const region = `region-${(i + operatorIndex + rng.int(config.regionCount)) % config.regionCount}`
    const reliability = clamp(0.82 + rng.next() * 0.17 + (operatorIndex % 3 === 0 ? 0.03 : 0), 0.75, 0.995)
    const latencyMs = Math.round(25 + rng.next() * 275 + (operatorIndex % 4) * 15)
    const score = clamp((reliability * 0.82) + ((300 - latencyMs) / 300 * 0.18), 0, 1)

    relays.push({
      pubkey: hexFromInt(i, operatorIndex),
      operator,
      region,
      reliability,
      latencyMs,
      score,
      malicious: maliciousOperators.has(operator),
      features: ['blind-custody', 'custody-expiry', 'non-serving-proof']
    })
  }
  return relays
}

function weightedOperatorIndex (relayIndex, rng, operatorCount) {
  if (relayIndex < operatorCount) return relayIndex
  if (rng.next() < 0.48) return rng.int(Math.max(3, Math.floor(operatorCount / 4)))
  return rng.int(operatorCount)
}

function pickRelays (network, count, strategy, rng, exclude = new Set()) {
  if (count <= 0) return []
  const pool = network.filter(relay => !exclude.has(relay.pubkey))
  if (strategy === 'random') return rng.shuffle(pool).slice(0, count)
  if (strategy === 'score') return [...pool].sort((a, b) => b.score - a.score || a.latencyMs - b.latencyMs).slice(0, count)
  return selectQuorum(pool, {
    strategy: 'diverse',
    size: count,
    minRegions: Math.min(4, count),
    requireFeatures: ['blind-custody']
  })
}

function relayAnchors (relay, rng) {
  const adversarialBoost = relay.malicious ? 0.04 : 0
  return rng.next() < clamp(relay.reliability + adversarialBoost, 0, 0.998)
}

function hasEnoughServingRelays (receipts, readThreshold, rng, config) {
  let serving = 0
  for (const relay of receipts) {
    const online = rng.next() < relay.reliability
    const censoring = relay.malicious && rng.next() < config.maliciousCensorRate
    if (online && !censoring) serving++
  }
  return serving >= readThreshold
}

function adversaryCanReconstruct (receipts, scenario) {
  const maliciousReceipts = receipts.filter(relay => relay.malicious).length
  if (scenario.fullMirror) return maliciousReceipts >= 1
  return maliciousReceipts >= scenario.readThreshold
}

function continuesServingAfterExpiry (relay, rng, config) {
  const p = relay.malicious ? config.maliciousContinuesServingRate : config.honestBugContinuesServingRate
  return rng.next() < p
}

function violationDetected (violators, honestWitnesses, rng, config) {
  if (violators.length === 0) return true
  for (let i = 0; i < violators.length; i++) {
    for (let j = 0; j < honestWitnesses.length; j++) {
      if (rng.next() < config.witnessDetectRate) return true
    }
  }
  return false
}

function summarizeBreakthrough (results) {
  const sharded = results.find(r => r.name === 'shards-10of16-diverse')
  const witnessed = results.find(r => r.name === 'shards-10of16-witness5')
  if (!sharded || !witnessed) return null
  return {
    primitive: 'witness-tombstone-quorum',
    observation: 'independent non-custody witnesses reduce undetected post-expiry serving without adding storage replicas or giving more relays content',
    undetectedServingReduction: round(sharded.undetectedActiveServing - witnessed.undetectedActiveServing),
    availabilityDelta: round(witnessed.availabilityAfterSourceStop - sharded.availabilityAfterSourceStop),
    ciphertextReconstructionDelta: round(witnessed.adversaryReconstructsCiphertext - sharded.adversaryReconstructsCiphertext)
  }
}

function printReport (config, results) {
  console.log('HiveRelay blind atomic custody simulation')
  console.log(`iterations=${config.iterations} seed=${config.seed}`)
  console.log(`network=${config.relayCount} relays, ${config.operatorCount} operators, ${config.regionCount} regions`)
  console.log('')
  console.log([
    pad('scenario', 26),
    pad('commit', 9),
    pad('avail', 9),
    pad('adv-recon', 11),
    pad('active-leak', 12),
    pad('undetected', 12),
    pad('ops', 6),
    pad('watchers', 8)
  ].join(' '))
  console.log('-'.repeat(99))
  for (const r of results) {
    console.log([
      pad(r.name, 26),
      pad(percent(r.commitRate), 9),
      pad(percent(r.availabilityAfterSourceStop), 9),
      pad(percent(r.adversaryReconstructsCiphertext), 11),
      pad(percent(r.activeServingViolation), 12),
      pad(percent(r.undetectedActiveServing), 12),
      pad(String(r.avgCustodyOperators), 6),
      pad(r.witnessCount ? `${r.avgHonestWitnesses}/${r.witnessCount}` : '0', 8)
    ].join(' '))
  }
  console.log('')
  const breakthrough = summarizeBreakthrough(results)
  console.log('Breakthrough candidate: Witness Tombstone Quorum')
  console.log(`- Undetected active-serving risk improvement: ${percent(breakthrough.undetectedServingReduction)}`)
  console.log(`- Availability delta versus diverse shards: ${percent(breakthrough.availabilityDelta)}`)
  console.log(`- Ciphertext reconstruction delta versus diverse shards: ${percent(breakthrough.ciphertextReconstructionDelta)}`)
  console.log('- Interpretation: add independent expiry witnesses before adding more custody replicas.')
}

function parseArgs (argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
    } else {
      parsed[key] = next
      i++
    }
  }
  return parsed
}

function toPositiveInt (value, fallback) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function toProbability (value, fallback) {
  if (value === undefined) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? clamp(n, 0, 1) : fallback
}

function hash32 (input) {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function hexFromInt (relayIndex, operatorIndex) {
  return `${relayIndex.toString(16).padStart(8, '0')}${operatorIndex.toString(16).padStart(8, '0')}`.padEnd(64, '0')
}

function ratio (num, den) {
  return round(num / den)
}

function round (n) {
  return Math.round(n * 10000) / 10000
}

function percent (n) {
  return `${(n * 100).toFixed(2)}%`
}

function pad (value, width) {
  const s = String(value)
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length)
}

function clamp (n, min, max) {
  return Math.max(min, Math.min(max, n))
}

class Rng {
  constructor (seed) {
    this.state = seed >>> 0
  }

  next () {
    this.state += 0x6D2B79F5
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  int (max) {
    return Math.floor(this.next() * max)
  }

  shuffle (items) {
    const copy = [...items]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      const tmp = copy[i]
      copy[i] = copy[j]
      copy[j] = tmp
    }
    return copy
  }
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  const iterations = toPositiveInt(args.iterations, DEFAULT_ITERATIONS)
  const seed = String(args.seed || DEFAULT_SEED)
  const json = args.json === true

  const config = {
    iterations,
    seed,
    relayCount: toPositiveInt(args.relays, 72),
    operatorCount: toPositiveInt(args.operators, 16),
    regionCount: toPositiveInt(args.regions, 7),
    maliciousOperatorRate: toProbability(args.maliciousOperators, 0.16),
    honestBugContinuesServingRate: toProbability(args.honestBugContinuesServing, 0.015),
    maliciousContinuesServingRate: toProbability(args.maliciousContinuesServing, 0.62),
    maliciousCensorRate: toProbability(args.maliciousCensor, 0.35),
    witnessDetectRate: toProbability(args.witnessDetect, 0.84)
  }

  const results = SCENARIOS.map(scenario => simulateScenario(scenario, config))

  if (json) {
    console.log(JSON.stringify({ config, results, breakthrough: summarizeBreakthrough(results) }, null, 2))
  } else {
    printReport(config, results)
  }
}

main()
