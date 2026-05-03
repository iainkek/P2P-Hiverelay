/**
 * AutoHeal tests.
 *
 * Verifies the diversity-enforced replica recruitment scheduler:
 *
 *   - Boundary: only archive-tier drives are tracked
 *   - Recruit when below threshold AND we'd add region diversity
 *   - Don't recruit when threshold met
 *   - Don't recruit when our region is already over-represented
 *   - Don't recruit when accept-mode disagrees
 *   - Don't recruit if we already have it
 *   - Cap at maxRecruitsPerTick
 *   - Stale peer entries get pruned
 *
 * Mocks RelayNode just enough that AutoHeal has the surface it expects.
 */

import test from 'brittle'
import { AutoHeal } from 'p2p-hiverelay/core/auto-heal.js'

// ─── Mock RelayNode ─────────────────────────────────────────────────

function makeNode (opts = {}) {
  const region = opts.region || 'NA'
  const pubkey = opts.pubkey || 'mypub'
  const localCatalog = opts.localCatalog || []
  const peerCatalogs = opts.peerCatalogs || []
  const acceptMode = opts.acceptMode || 'open'
  const seededApps = []

  const node = {
    config: { regions: [region], autoHeal: { enabled: true } },
    swarm: { keyPair: { publicKey: pubkey } },
    appRegistry: {
      catalog: () => localCatalog,
      has: (key) => localCatalog.some(e => e.appKey === key) || seededApps.includes(key)
    },
    federation: {
      snapshot: () => ({ peerCatalogs })
    },
    seedApp: async (appKey, options) => {
      if (opts.seedApp) await opts.seedApp(appKey, options)
      seededApps.push(appKey)
    },
    _resolveAcceptMode: () => acceptMode,
    _decideAcceptance: (req, mode) => {
      if (mode === 'closed') return 'reject'
      if (mode === 'allowlist') return 'reject'
      return 'accept'
    },
    _seededApps: seededApps
  }
  return node
}

// ─── Tests ──────────────────────────────────────────────────────────

test('AutoHeal: ignores non-archive drives', async (t) => {
  const node = makeNode({
    peerCatalogs: [{
      pubkey: 'peerA',
      region: 'EU',
      apps: [
        { appKey: 'standard-drive', durability: 0, anchored: true },
        { appKey: 'archive-drive', durability: 1, anchored: true }
      ]
    }]
  })
  const heal = new AutoHeal(node, {
    tickMs: 60_000,
    thresholds: { minReplicas: 2, minRegions: 2, minOperators: 2 }
  })
  heal._running = true
  await heal._tick()

  const snap = heal.snapshot()
  const tracked = snap.drives.map(d => d.appKey)
  t.ok(tracked.includes('archive-drive'), 'archive drive tracked')
  t.absent(tracked.includes('standard-drive'), 'standard drive ignored')
})

test('AutoHeal: recruits when below threshold AND adds region diversity', async (t) => {
  const recruited = []
  const node = makeNode({
    region: 'AS',
    pubkey: 'mypub',
    peerCatalogs: [{
      pubkey: 'peerA',
      region: 'NA',
      apps: [{ appKey: 'archive-drive', durability: 1, anchored: true }]
    }],
    seedApp: async (appKey, opts) => recruited.push({ appKey, opts })
  })
  const heal = new AutoHeal(node, {
    tickMs: 60_000,
    thresholds: { minReplicas: 3, minRegions: 2, minOperators: 2 }
  })
  heal._running = true
  await heal._tick()

  t.is(recruited.length, 1, 'recruited once')
  t.is(recruited[0].appKey, 'archive-drive')
  t.is(recruited[0].opts.durability, 1, 'recruited as archive tier')
  t.is(recruited[0].opts.revocable, false, 'archive recruits are non-revocable')
  t.is(recruited[0].opts.source, 'auto-heal')
})

test('AutoHeal: does NOT recruit when threshold already met', async (t) => {
  const recruited = []
  const node = makeNode({
    region: 'OC',
    peerCatalogs: [{
      pubkey: 'peerA',
      region: 'NA',
      apps: [{ appKey: 'archive-drive', durability: 1, anchored: true }]
    }, {
      pubkey: 'peerB',
      region: 'EU',
      apps: [{ appKey: 'archive-drive', durability: 1, anchored: true }]
    }, {
      pubkey: 'peerC',
      region: 'AS',
      apps: [{ appKey: 'archive-drive', durability: 1, anchored: true }]
    }],
    seedApp: async (k, o) => recruited.push({ k, o })
  })
  const heal = new AutoHeal(node, {
    tickMs: 60_000,
    thresholds: { minReplicas: 3, minRegions: 3, minOperators: 3 }
  })
  heal._running = true
  await heal._tick()

  t.is(recruited.length, 0, 'no recruitment — threshold already satisfied')
})

test('AutoHeal: does NOT recruit when our region adds no diversity', async (t) => {
  const recruited = []
  // We're NA. There are already 4 NA replicas (over-represented). Threshold
  // requires minRegions=4 and we can't help with that goal. Stay out.
  const node = makeNode({
    region: 'NA',
    peerCatalogs: [
      { pubkey: 'p1', region: 'NA', apps: [{ appKey: 'archive-drive', durability: 1, anchored: true }] },
      { pubkey: 'p2', region: 'NA', apps: [{ appKey: 'archive-drive', durability: 1, anchored: true }] },
      { pubkey: 'p3', region: 'NA', apps: [{ appKey: 'archive-drive', durability: 1, anchored: true }] },
      { pubkey: 'p4', region: 'NA', apps: [{ appKey: 'archive-drive', durability: 1, anchored: true }] }
    ],
    seedApp: async (k, o) => recruited.push({ k, o })
  })
  const heal = new AutoHeal(node, {
    tickMs: 60_000,
    thresholds: { minReplicas: 3, minRegions: 3, minOperators: 3 }
  })
  heal._running = true
  await heal._tick()

  t.is(recruited.length, 0, 'declined — no region diversity gain')
})

test('AutoHeal: does NOT recruit when accept-mode rejects', async (t) => {
  const recruited = []
  const node = makeNode({
    region: 'AS',
    acceptMode: 'closed',
    peerCatalogs: [{
      pubkey: 'peerA',
      region: 'NA',
      apps: [{ appKey: 'archive-drive', durability: 1, anchored: true }]
    }],
    seedApp: async (k, o) => recruited.push({ k, o })
  })
  const heal = new AutoHeal(node, {
    tickMs: 60_000,
    thresholds: { minReplicas: 3, minRegions: 2, minOperators: 2 }
  })
  heal._running = true
  await heal._tick()

  t.is(recruited.length, 0, 'closed accept-mode wins over auto-heal')
})

test('AutoHeal: does NOT recruit if we already host the drive', async (t) => {
  const recruited = []
  const node = makeNode({
    region: 'AS',
    pubkey: 'mypub',
    localCatalog: [{
      appKey: 'archive-drive',
      durability: 1,
      anchored: true
    }],
    peerCatalogs: [{
      pubkey: 'peerA',
      region: 'NA',
      apps: [{ appKey: 'archive-drive', durability: 1, anchored: true }]
    }],
    seedApp: async (k, o) => recruited.push({ k, o })
  })
  const heal = new AutoHeal(node, {
    tickMs: 60_000,
    thresholds: { minReplicas: 5, minRegions: 5, minOperators: 5 }
  })
  heal._running = true
  await heal._tick()

  t.is(recruited.length, 0, 'already hosting — no self-recruit')
})

test('AutoHeal: caps recruits per tick at maxRecruitsPerTick', async (t) => {
  const recruited = []
  // Five different archive drives all need this relay's region. Cap should
  // keep us from picking up all five in one tick.
  const peerCatalogs = [{
    pubkey: 'peerA',
    region: 'NA',
    apps: [
      { appKey: 'a1', durability: 1, anchored: true },
      { appKey: 'a2', durability: 1, anchored: true },
      { appKey: 'a3', durability: 1, anchored: true },
      { appKey: 'a4', durability: 1, anchored: true },
      { appKey: 'a5', durability: 1, anchored: true }
    ]
  }]
  const node = makeNode({
    region: 'OC',
    peerCatalogs,
    seedApp: async (k, o) => recruited.push({ k, o })
  })
  const heal = new AutoHeal(node, {
    tickMs: 60_000,
    thresholds: { minReplicas: 3, minRegions: 2, minOperators: 2 },
    maxRecruitsPerTick: 2
  })
  heal._running = true
  await heal._tick()

  t.is(recruited.length, 2, 'cap honored')
})

test('AutoHeal: prunes stale peer entries past staleMs', async (t) => {
  const recruited = []
  const node = makeNode({
    region: 'AS',
    peerCatalogs: [{
      pubkey: 'peerA',
      region: 'NA',
      apps: [{ appKey: 'archive-drive', durability: 1, anchored: true }]
    }],
    seedApp: async (k, o) => recruited.push({ k, o })
  })
  const heal = new AutoHeal(node, {
    tickMs: 60_000,
    staleMs: 1, // stale immediately
    thresholds: { minReplicas: 2, minRegions: 2, minOperators: 2 },
    random: () => 0 // deterministic: jitter always accepts
  })

  heal._running = true
  await heal._tick()
  // First tick: recruited
  t.ok(recruited.length >= 1)

  // Now drain federation — peer disappears
  node.federation.snapshot = () => ({ peerCatalogs: [] })

  // Wait one tick interval to let staleness kick in
  await new Promise(r => setTimeout(r, 10))
  heal._running = true
  await heal._tick()

  const snap = heal.snapshot()
  // Local entry persists (we have it now), peer entry pruned
  for (const drive of snap.drives) {
    if (drive.appKey === 'archive-drive') {
      // We're the only one left. Replicas count <= 1 (just us if anchored).
      t.ok(drive.replicas <= 1, 'stale peer pruned')
    }
  }
})

test('AutoHeal: snapshot reports correct diversity', async (t) => {
  const node = makeNode({
    region: 'AS',
    peerCatalogs: [
      { pubkey: 'p1', region: 'NA', apps: [{ appKey: 'd', durability: 1, anchored: true }] },
      { pubkey: 'p2', region: 'EU', apps: [{ appKey: 'd', durability: 1, anchored: true }] },
      { pubkey: 'p3', region: 'NA', apps: [{ appKey: 'd', durability: 1, anchored: true }] }
    ]
  })
  const heal = new AutoHeal(node, {
    tickMs: 60_000,
    thresholds: { minReplicas: 5, minRegions: 5, minOperators: 5 }
  })
  heal._running = true
  await heal._tick()

  const snap = heal.snapshot()
  const drive = snap.drives.find(d => d.appKey === 'd')
  t.ok(drive)
  t.is(drive.regions.length, 2, 'distinct regions counted (NA, EU)')
  t.is(drive.operators.length, 3, 'distinct operators counted')
  t.absent(drive.meetsThreshold, 'reports below threshold')
})

// ─── New gates added in pre-merge hardening ─────────────────────────

test('AutoHeal: refuses to recruit when storage cap reached', async (t) => {
  const recruited = []
  const node = makeNode({
    region: 'AS',
    peerCatalogs: [{
      pubkey: 'peerA',
      region: 'NA',
      apps: [{ appKey: 'archive-drive', durability: 1, anchored: true }]
    }],
    seedApp: async (k, o) => recruited.push({ k, o })
  })
  // Configure tight storage: 1MB cap, already at 950KB (95% used > 90% margin)
  node.config.maxStorageBytes = 1024 * 1024
  node.seeder = { totalBytesStored: 950 * 1024 }
  const heal = new AutoHeal(node, {
    tickMs: 60_000,
    thresholds: { minReplicas: 3, minRegions: 2, minOperators: 2 },
    random: () => 0 // jitter always accepts so the storage gate is the only thing blocking
  })
  heal._running = true
  const skipped = []
  heal.on('recruit-skipped', (info) => skipped.push(info))
  await heal._tick()

  t.is(recruited.length, 0, 'declined recruit')
  t.ok(skipped.find(s => s.reason === 'storage-full'), 'emitted storage-full skip event')
})

test('AutoHeal: backs off retrying a drive after a recruit error', async (t) => {
  const errors = []
  const node = makeNode({
    region: 'AS',
    peerCatalogs: [{
      pubkey: 'peerA',
      region: 'NA',
      apps: [{ appKey: 'broken-drive', durability: 1, anchored: true }]
    }]
  })
  // Make seedApp always fail to simulate an un-replicable drive
  node.seedApp = async () => { throw new Error('REPLICATION_FAILED') }
  const heal = new AutoHeal(node, {
    tickMs: 60_000,
    thresholds: { minReplicas: 3, minRegions: 2, minOperators: 2 },
    random: () => 0
  })
  heal._running = true
  heal.on('recruit-error', (info) => errors.push(info))

  // Tick 1 — fails, records backoff
  await heal._tick()
  t.is(errors.length, 1, 'first attempt errored')

  // Tick 2 — should be in backoff, no second error
  await heal._tick()
  t.is(errors.length, 1, 'second tick skipped (in backoff)')

  // Snapshot reports the backoff
  const snap = heal.snapshot()
  const drive = snap.drives.find(d => d.appKey === 'broken-drive')
  t.ok(drive.backoff, 'backoff state surfaced')
  t.is(drive.backoff.failures, 1)
  t.ok(drive.backoff.retryInMs > 0, 'retry-in-ms is positive')
})

test('AutoHeal: jitter probabilistically declines recruitment', async (t) => {
  // With many helpers and a small gap, individual relays should sometimes
  // back off so the fleet doesn't all recruit simultaneously.
  const node = makeNode({
    region: 'AS',
    peerCatalogs: [
      // 30 peers, all in NA, drive needs 1 more replica + 1 more region
      ...Array.from({ length: 30 }, (_, i) => ({
        pubkey: `peer${i}`,
        region: 'NA',
        apps: [{ appKey: 'archive-drive', durability: 1, anchored: true }]
      }))
    ]
  })
  // Hit the dice on the LOSING side — random returns 0.99, gap small,
  // probability low → decline.
  const heal = new AutoHeal(node, {
    tickMs: 60_000,
    thresholds: { minReplicas: 30, minRegions: 2, minOperators: 30 },
    random: () => 0.99
  })
  heal._running = true
  const skipped = []
  heal.on('recruit-skipped', (info) => skipped.push(info))
  let recruited = 0
  const origSeed = node.seedApp
  node.seedApp = async (...args) => { recruited++; return origSeed?.(...args) }
  await heal._tick()

  // Drive needs 1 more region (we'd add AS) — region gap = 1.
  // Helpers ~ 30. probability ≈ (1 * 2) / 30 = 0.067. random=0.99 > 0.067 → decline.
  t.is(recruited, 0, 'jitter declined')
  t.ok(skipped.find(s => s.reason === 'jitter-defer'), 'emitted jitter-defer skip event')
})

test('AutoHeal: jitter accepts when probability is high', async (t) => {
  // Same setup but tiny fleet + large gap → probability ≈ 1.0 → accept.
  const recruited = []
  const node = makeNode({
    region: 'AS',
    peerCatalogs: [{
      pubkey: 'peerA',
      region: 'NA',
      apps: [{ appKey: 'archive-drive', durability: 1, anchored: true }]
    }],
    seedApp: async (k, o) => recruited.push({ k, o })
  })
  const heal = new AutoHeal(node, {
    tickMs: 60_000,
    thresholds: { minReplicas: 5, minRegions: 4, minOperators: 5 },
    random: () => 0.5 // mid-range; should pass since prob is 1.0
  })
  heal._running = true
  await heal._tick()

  t.is(recruited.length, 1, 'recruited (probability was 1.0)')
})

test('AutoHeal: snapshot exposes new fields (running, backoffs, below)', async (t) => {
  const node = makeNode({
    region: 'AS',
    peerCatalogs: [
      { pubkey: 'p1', region: 'NA', apps: [{ appKey: 'd1', durability: 1, anchored: true }] },
      { pubkey: 'p2', region: 'EU', apps: [{ appKey: 'd2', durability: 1, anchored: true }] }
    ]
  })
  const heal = new AutoHeal(node, {
    tickMs: 60_000,
    thresholds: { minReplicas: 5, minRegions: 5, minOperators: 5 },
    random: () => 0.99 // decline jitter so we just observe state
  })
  heal._running = true
  await heal._tick()

  const snap = heal.snapshot()
  t.is(snap.enabled, true)
  t.is(snap.running, true)
  t.is(snap.tracked, 2)
  t.is(snap.below, 2, 'both drives below threshold')
  t.is(snap.backoffs, 0, 'no failures yet')
  t.ok(snap.maxRecruitsPerTick)
  t.ok(snap.storageMargin)
})

test('AutoHeal: only counts ANCHORED replicas as live', async (t) => {
  // A relay that "accepted" but hasn't anchored is not a real availability
  // vote. Diversity scoring should ignore those.
  const node = makeNode({
    region: 'OC',
    peerCatalogs: [
      { pubkey: 'p1', region: 'NA', apps: [{ appKey: 'd', durability: 1, anchored: true }] },
      { pubkey: 'p2', region: 'EU', apps: [{ appKey: 'd', durability: 1, anchored: false }] },
      { pubkey: 'p3', region: 'AS', apps: [{ appKey: 'd', durability: 1, anchored: false }] }
    ]
  })
  const heal = new AutoHeal(node, { tickMs: 60_000 })
  heal._running = true
  await heal._tick()

  const snap = heal.snapshot()
  const drive = snap.drives.find(d => d.appKey === 'd')
  t.is(drive.replicas, 1, 'unanchored peers do not count')
  t.is(drive.regions.length, 1)
})
