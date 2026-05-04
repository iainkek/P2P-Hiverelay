import test from 'brittle'
import { randomBytes } from 'crypto'
import { SeedingRegistry } from 'p2p-hiverelay/core/registry/index.js'

function mockStore () {
  return {
    get () {
      return {
        key: randomBytes(32),
        length: 0,
        async ready () {},
        replicate () {},
        on () {},
        async close () {},
        async get () { return null }
      }
    }
  }
}

function mockSwarm () {
  return {
    keyPair: { publicKey: randomBytes(32) }
  }
}

test('SeedingRegistry - rejects meta announce when declared peer key mismatches transport key', (t) => {
  const registry = new SeedingRegistry(mockStore(), mockSwarm())
  let called = 0
  registry._registerPeerLog = async () => { called++ }

  const transportKey = randomBytes(32)
  registry._onMetaMessage({}, { publicKey: transportKey }, {
    type: 0,
    logKey: 'a'.repeat(64),
    peerPubkey: 'b'.repeat(64)
  })

  t.is(called, 0, 'registry ignores mismatched peer identity claim')
})

test('SeedingRegistry - rejects forged seed-accept relay pubkey attribution', (t) => {
  const registry = new SeedingRegistry(mockStore(), mockSwarm())
  const appKey = 'a'.repeat(64)

  registry._applyEntry({
    type: 'seed-accept',
    timestamp: Date.now(),
    appKey,
    relayPubkey: 'b'.repeat(64),
    region: 'na'
  }, {
    logId: 'deadbeef',
    peerPubkey: 'c'.repeat(64)
  })

  t.is(registry._acceptances.get(appKey), undefined, 'mismatched relay identity not indexed')
})

test('SeedingRegistry - accepts seed-accept when relay identity matches log peer', (t) => {
  const registry = new SeedingRegistry(mockStore(), mockSwarm())
  const appKey = 'a'.repeat(64)
  const relayPubkey = 'd'.repeat(64)

  registry._applyEntry({
    type: 'seed-accept',
    timestamp: Date.now(),
    appKey,
    relayPubkey,
    region: 'na'
  }, {
    logId: 'feedface',
    peerPubkey: relayPubkey
  })

  const acceptances = registry._acceptances.get(appKey)
  t.ok(Array.isArray(acceptances), 'acceptance list created')
  t.is(acceptances.length, 1, 'matching acceptance indexed')
  t.is(acceptances[0].relayPubkey, relayPubkey, 'relay pubkey preserved')
})

test('SeedingRegistry - enforces max peer log cap', async (t) => {
  const registry = new SeedingRegistry(mockStore(), mockSwarm(), { maxPeerLogs: 1 })
  registry.localLog = { key: randomBytes(32) }
  registry._peerLogMeta.set('f'.repeat(64), {
    log: { replicate () {} },
    onAppend: null,
    peerPubkey: '1'.repeat(64)
  })

  await registry._registerPeerLog('a'.repeat(64), '2'.repeat(64), {})
  t.is(registry._peerLogMeta.size, 1, 'new peer log rejected once cap is reached')
})
