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
    thresholds: { minReplicas: 2, minRegions: 2, minOperators: 2 }
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
