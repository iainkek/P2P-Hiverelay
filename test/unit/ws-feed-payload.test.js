/**
 * Tests that the WebSocket dashboard feed surfaces AutoHeal + custody state
 * in its broadcast payload. Tests the payload builder directly with a mock
 * node — avoids spinning up a real HTTP server / WebSocket clients.
 */

import test from 'brittle'
import { DashboardFeed } from 'p2p-hiverelay/core/relay-node/ws-feed.js'

function makeMockNode (opts = {}) {
  return {
    running: true,
    config: { regions: ['NA'], maxStorageBytes: 1024 * 1024 * 1024 },
    swarm: { keyPair: { publicKey: 'mockpubkey' } },
    startedAt: Date.now() - 60_000,
    getStats: () => ({
      publicKey: 'mockpubkey',
      connections: { active: 0, total: 0 },
      seededApps: 0,
      relay: { activeCircuits: 0, totalCircuitsServed: 0, totalBytesRelayed: 0 },
      seeder: { coresSeeded: 0, totalBytesStored: 0, totalBytesServed: 0 }
    }),
    autoHeal: opts.autoHeal,
    seedingRegistry: opts.seedingRegistry,
    metrics: null,
    reputation: null,
    torTransport: null,
    holesailTransport: null,
    creditManager: null,
    serviceMeter: null,
    invoiceManager: null,
    paymentManager: null,
    networkDiscovery: null
  }
}

function makeFeed (node) {
  // Construct the feed without starting (no server needed for _buildPayload)
  const feed = new DashboardFeed({ node, server: null })
  feed.clientCount = 1 // pretend a client is connected
  return feed
}

test('ws-feed: payload omits autoHeal block when node has no autoHeal', async (t) => {
  const node = makeMockNode({ autoHeal: null })
  const payload = makeFeed(node)._buildPayload()
  t.absent(payload.autoHeal, 'no autoHeal in payload')
})

test('ws-feed: payload includes autoHeal snapshot when present', async (t) => {
  const autoHealSnap = {
    enabled: true,
    running: true,
    tickMs: 60_000,
    thresholds: { minReplicas: 7, minRegions: 4, minOperators: 5 },
    tracked: 3,
    below: 1,
    backoffs: 0,
    verifyProofs: true,
    proofCacheSize: 12,
    drives: [
      { appKey: 'a', replicas: 7, regions: ['NA', 'EU', 'AS', 'OC'], operators: ['a', 'b', 'c', 'd', 'e'], meetsThreshold: true, haveLocally: true, backoff: null }
    ]
  }
  const node = makeMockNode({
    autoHeal: { snapshot: () => autoHealSnap }
  })
  const payload = makeFeed(node)._buildPayload()
  t.ok(payload.autoHeal, 'autoHeal block present')
  t.is(payload.autoHeal.tracked, 3)
  t.is(payload.autoHeal.below, 1)
  t.is(payload.autoHeal.verifyProofs, true)
  t.is(payload.autoHeal.proofCacheSize, 12)
  t.is(payload.autoHeal.drives.length, 1)
})

test('ws-feed: payload caps autoHeal.drives at 50 to bound payload size', async (t) => {
  const drives = []
  for (let i = 0; i < 200; i++) {
    drives.push({ appKey: 'a' + i, replicas: 0, regions: [], operators: [], meetsThreshold: false, haveLocally: false, backoff: null })
  }
  const node = makeMockNode({
    autoHeal: {
      snapshot: () => ({
        enabled: true, running: true, tickMs: 60_000, thresholds: {}, tracked: 200, below: 200, backoffs: 0, verifyProofs: true, proofCacheSize: 0, drives
      })
    }
  })
  const payload = makeFeed(node)._buildPayload()
  t.is(payload.autoHeal.drives.length, 50, 'drives capped at 50')
  t.is(payload.autoHeal.tracked, 200, 'tracked count preserved (full count surfaced)')
})

test('ws-feed: payload includes custody snapshot when registry has one', async (t) => {
  const node = makeMockNode({
    seedingRegistry: {
      custodySnapshot: () => ({
        intents: 5,
        withQuorum: 3,
        committed: 2,
        retired: 1,
        withProof: 2,
        withNonServingProof: 0,
        totalReceipts: 9,
        totalProofs: 4,
        totalNonServingProofs: 0,
        commitRate: 0.4
      })
    }
  })
  const payload = makeFeed(node)._buildPayload()
  t.ok(payload.custody, 'custody block present')
  t.is(payload.custody.intents, 5)
  t.is(payload.custody.committed, 2)
  t.is(payload.custody.commitRate, 0.4)
})

test('ws-feed: payload omits custody when no registry', async (t) => {
  const node = makeMockNode({ seedingRegistry: null })
  const payload = makeFeed(node)._buildPayload()
  t.absent(payload.custody, 'no custody in payload')
})

test('ws-feed: payload swallows snapshot errors (does not crash broadcast)', async (t) => {
  const node = makeMockNode({
    autoHeal: { snapshot: () => { throw new Error('boom') } },
    seedingRegistry: { custodySnapshot: () => { throw new Error('boom') } }
  })
  const payload = makeFeed(node)._buildPayload()
  // Must still produce a valid payload — autoHeal/custody just absent
  t.ok(payload.overview, 'overview still present')
  t.absent(payload.autoHeal, 'autoHeal absent on snapshot error')
  t.absent(payload.custody, 'custody absent on snapshot error')
})
