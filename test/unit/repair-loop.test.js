import test from 'brittle'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AppRegistry } from 'p2p-hiverelay/core/app-registry.js'
import { AppLifecycle } from 'p2p-hiverelay/core/relay-node/app-lifecycle.js'

function tmpDir () {
  const d = mkdtempSync(join(tmpdir(), 'repair-test-'))
  return { dir: d, cleanup: () => rmSync(d, { recursive: true, force: true }) }
}

// Minimal mock of RelayNode for AppLifecycle's repair primitive
function mockNode (registry, opts = {}) {
  return {
    appRegistry: registry,
    swarm: opts.swarm || {
      join: () => {},
      flush: () => Promise.resolve()
    },
    seeder: opts.seeder || null,
    distributedDriveBridge: null,
    seededApps: registry?.apps || new Map(),
    config: opts.config || {}
  }
}

// Mock drive that simulates the Hyperdrive surface AppLifecycle uses
function mockDrive ({ version = 0, updateOk = true, downloadOk = true, throwsOnUpdate = false } = {}) {
  const drive = {
    closed: false,
    closing: false,
    version,
    discoveryKey: Buffer.alloc(32, 0xab),
    update: async () => {
      if (throwsOnUpdate) throw new Error('boom')
      if (!updateOk) await new Promise(resolve => setTimeout(resolve, 100_000))
      drive.version = Math.max(drive.version, 1)
    },
    download: () => ({
      done: async () => {
        if (!downloadOk) await new Promise(resolve => setTimeout(resolve, 100_000))
      }
    })
  }
  return drive
}

test('repair: returns false when drive missing', async (t) => {
  const { dir, cleanup } = tmpDir(); t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  reg.set('aa', { type: 'app' })
  const lifecycle = new AppLifecycle(mockNode(reg))
  const ok = await lifecycle.repairUnanchored('aa')
  t.is(ok, false)
})

test('repair: returns true when already anchored', async (t) => {
  const { dir, cleanup } = tmpDir(); t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  const drive = mockDrive({ version: 5 })
  reg.set('bb', { type: 'app', drive })
  reg.setAnchored('bb', 5)
  const lifecycle = new AppLifecycle(mockNode(reg))
  const ok = await lifecycle.repairUnanchored('bb')
  t.is(ok, true)
})

test('repair: succeeds when drive update yields version > 0', async (t) => {
  const { dir, cleanup } = tmpDir(); t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  const drive = mockDrive({ version: 0, updateOk: true })
  reg.set('cc', { type: 'app', drive, discoveryKey: drive.discoveryKey })
  const lifecycle = new AppLifecycle(mockNode(reg))
  const ok = await lifecycle.repairUnanchored('cc', { updateTimeout: 500, downloadTimeout: 500 })
  t.is(ok, true, 'returns true')
  const e = reg.get('cc')
  t.is(e.anchored, true, 'entry marked anchored')
  t.ok(e.anchoredLength > 0)
})

test('repair: returns false on update timeout', async (t) => {
  const { dir, cleanup } = tmpDir(); t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  const drive = mockDrive({ version: 0, updateOk: false })
  reg.set('dd', { type: 'app', drive, discoveryKey: drive.discoveryKey })
  const lifecycle = new AppLifecycle(mockNode(reg))
  const ok = await lifecycle.repairUnanchored('dd', { updateTimeout: 200, downloadTimeout: 200 })
  t.is(ok, false)
  const e = reg.get('dd')
  t.is(e.anchored, false, 'entry stays unanchored')
})

test('repair: returns false on update throw', async (t) => {
  const { dir, cleanup } = tmpDir(); t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  const drive = mockDrive({ version: 0, throwsOnUpdate: true })
  reg.set('ee', { type: 'app', drive, discoveryKey: drive.discoveryKey })
  const lifecycle = new AppLifecycle(mockNode(reg))
  const ok = await lifecycle.repairUnanchored('ee', { updateTimeout: 500, downloadTimeout: 500 })
  t.is(ok, false)
})

test('runRepairPass: aggregates checked / repaired / stillUnanchored', async (t) => {
  const { dir, cleanup } = tmpDir(); t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  // 1 already-anchored (skipped)
  const d1 = mockDrive({ version: 3 })
  reg.set('a1', { type: 'app', drive: d1, discoveryKey: d1.discoveryKey })
  reg.setAnchored('a1', 3)
  // 1 will-repair
  const d2 = mockDrive({ version: 0, updateOk: true })
  reg.set('a2', { type: 'app', drive: d2, discoveryKey: d2.discoveryKey })
  // 1 won't-repair (timeout)
  const d3 = mockDrive({ version: 0, updateOk: false })
  reg.set('a3', { type: 'app', drive: d3, discoveryKey: d3.discoveryKey })

  const lifecycle = new AppLifecycle(mockNode(reg))
  // Override default timeouts for fast tests
  lifecycle.repairUnanchored = async function (key) {
    if (key === 'a2') {
      reg.setAnchored(key, 1)
      return true
    }
    return false
  }
  const result = await lifecycle.runRepairPass({ maxConcurrent: 2 })
  t.is(result.checked, 2, 'a1 skipped (anchored)')
  t.is(result.repaired, 1, 'a2 repaired')
  t.is(result.stillUnanchored, 1, 'a3 still unanchored')
})

test('runRepairPass: respects budget', async (t) => {
  const { dir, cleanup } = tmpDir(); t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  for (let i = 0; i < 10; i++) {
    const d = mockDrive()
    reg.set('app' + i, { type: 'app', drive: d, discoveryKey: d.discoveryKey })
  }
  const lifecycle = new AppLifecycle(mockNode(reg))
  lifecycle.repairUnanchored = async () => false // all fail, but counted
  const result = await lifecycle.runRepairPass({ budget: 3 })
  t.is(result.checked, 3, 'budget honored')
})

test('runRepairPass: skips entries without drive', async (t) => {
  const { dir, cleanup } = tmpDir(); t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  reg.set('nodrive', { type: 'app' }) // no drive instance
  const d = mockDrive()
  reg.set('hasdrive', { type: 'app', drive: d, discoveryKey: d.discoveryKey })

  const lifecycle = new AppLifecycle(mockNode(reg))
  lifecycle.repairUnanchored = async () => false
  const result = await lifecycle.runRepairPass()
  t.is(result.checked, 1, 'only entry with drive checked')
})

test('catalogForBroadcast includes anchored field', (t) => {
  const { dir, cleanup } = tmpDir(); t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  reg.set('a', { type: 'app' })
  reg.set('b', { type: 'app' })
  reg.setAnchored('a', 5)
  const broadcast = reg.catalogForBroadcast()
  const a = broadcast.find(x => x.appKey === 'a')
  const b = broadcast.find(x => x.appKey === 'b')
  t.is(a.anchored, true, 'a is anchored')
  t.is(b.anchored, false, 'b is not anchored')
})
