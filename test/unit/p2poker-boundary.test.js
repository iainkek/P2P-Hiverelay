import test from 'brittle'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const capabilitySources = [
  'packages/services/builtin/opaque-core-availability-service.js',
  'packages/services/builtin/opaque-core-availability-protocol.js',
  'packages/client/opaque-core-availability.js'
]

const forbiddenSemantics = [
  /\bP2Poker\b/i,
  /\bPokerApp\b/,
  /table[-_ ]?log/i,
  /\breducer\b/i,
  /mental[-_ ]?poker/i,
  /\bsettlement\b/i,
  /\bmoney\b/i,
  /\bholeCards?\b/i,
  /\bcardValues?\b/i,
  /\bdeckValues?\b/i,
  /\bplayerSecret\w*\b/i,
  /\bwriterSecret\w*\b/i,
  /\bprivateKey\b/i,
  /\baddWriter\b/,
  /\bremoveWriter\b/,
  /\blinearizer\b/i,
  /\bindexer\b/i,
  /\bAutobase\b/
]

const forbiddenImports = [
  /(?:from\s+|import\s*\()['"][^'"]*poker/i,
  /(?:from\s+|import\s*\()['"][^'"]*(?:money|settlement|reducer|table-log|autobase)/i
]

test('opaque-core capability has no poker, money, reducer, or player-authority dependency', (t) => {
  let scanned = 0
  for (const relativePath of capabilitySources) {
    const filename = path.join(root, relativePath)
    if (!fs.existsSync(filename)) continue
    scanned++
    const source = fs.readFileSync(filename, 'utf8')
    for (const pattern of forbiddenImports) {
      t.absent(pattern.test(source), `${relativePath} must not import ${pattern}`)
    }
    for (const pattern of forbiddenSemantics) {
      t.absent(pattern.test(source), `${relativePath} must not name ${pattern}`)
    }
    t.absent(/\.append\s*\(/.test(source), `${relativePath} cannot append to a client core`)
  }

  const contract = fs.readFileSync(path.join(root, 'test/unit/seeded-core-service.test.js'), 'utf8')
  t.ok(contract.includes("capabilities: ['register', 'status', 'prove']"), 'contract exposes only generic availability operations')
  t.ok(contract.includes('coreKey'), 'contract accepts public core keys')
  t.ok(contract.includes('local-only'), 'contract requires local possession')
  t.comment(scanned === 0
    ? 'production capability is intentionally absent at the RED contract boundary'
    : `scanned ${scanned} production capability modules`)
})

test('package graph does not add poker, Autobase, or settlement dependencies for availability', (t) => {
  for (const relativePath of ['packages/core/package.json', 'packages/services/package.json', 'packages/client/package.json']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
    const dependencyNames = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })
    for (const dependency of dependencyNames) {
      t.absent(/p2poker|mental-poker|autobase|settlement|poker-evaluator|pokersolver/i.test(dependency), `${relativePath}: ${dependency}`)
    }
  }
})

test('relay identity vocabulary is restricted to transport authentication and proof signing', (t) => {
  for (const relativePath of capabilitySources) {
    const filename = path.join(root, relativePath)
    if (!fs.existsSync(filename)) continue
    const source = fs.readFileSync(filename, 'utf8')
    const identityLines = source.split(/\r?\n/).filter(line => /remotePubkey|relayPubkey|keyPair/.test(line))
    for (const line of identityLines) {
      t.ok(/auth|caller|context|noise|proof|sign|relay|keyPair|pubkey|publicKey/i.test(line), `${relativePath}: identity use is transport/proof-only`)
      t.absent(/writer|indexer|quorum|member|append/i.test(line), `${relativePath}: relay identity cannot become table authority`)
    }
  }
})
