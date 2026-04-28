import test from 'brittle'
import { AppRegistry } from 'p2p-hiverelay/core/app-registry.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function tmpDir () {
  const d = mkdtempSync(join(tmpdir(), 'anchor-test-'))
  return { dir: d, cleanup: () => rmSync(d, { recursive: true, force: true }) }
}

test('AppRegistry — anchored defaults to false on new entry', (t) => {
  const { dir, cleanup } = tmpDir()
  t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  reg.set('aa', { type: 'app', startedAt: Date.now() })
  const e = reg.get('aa')
  t.is(e.anchored, false, 'anchored=false by default')
  t.is(e.anchoredAt, null, 'anchoredAt=null')
  t.is(e.anchoredLength, 0, 'anchoredLength=0')
  t.is(e.lastAnchorCheck, null, 'lastAnchorCheck=null')
})

test('AppRegistry — setAnchored marks entry + records timestamp + length', (t) => {
  const { dir, cleanup } = tmpDir()
  t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  reg.set('bb', { type: 'app' })
  const before = Date.now()
  const ok = reg.setAnchored('bb', 42)
  t.is(ok, true, 'returns true')
  const e = reg.get('bb')
  t.is(e.anchored, true)
  t.is(e.anchoredLength, 42)
  t.ok(e.anchoredAt >= before, 'anchoredAt set')
  t.ok(e.lastAnchorCheck >= before, 'lastAnchorCheck set')
})

test('AppRegistry — setAnchored idempotent + only grows length', (t) => {
  const { dir, cleanup } = tmpDir()
  t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  reg.set('cc', { type: 'app' })
  reg.setAnchored('cc', 100)
  const firstAt = reg.get('cc').anchoredAt
  // Calling again with smaller length doesn't shrink
  reg.setAnchored('cc', 50)
  const e = reg.get('cc')
  t.is(e.anchoredLength, 100, 'kept larger value')
  t.is(e.anchoredAt, firstAt, 'first anchoredAt preserved')
})

test('AppRegistry — clearAnchored only fires when previously anchored', (t) => {
  const { dir, cleanup } = tmpDir()
  t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  reg.set('dd', { type: 'app' })
  // Not anchored yet — clear is a no-op
  t.is(reg.clearAnchored('dd'), false)
  // Anchor it
  reg.setAnchored('dd', 5)
  // Now clear works
  t.is(reg.clearAnchored('dd', 'test'), true)
  const e = reg.get('dd')
  t.is(e.anchored, false)
  t.is(e.anchoredLength, 0)
})

test('AppRegistry — recordAnchorCheck updates lastAnchorCheck without changing state', (t) => {
  const { dir, cleanup } = tmpDir()
  t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  reg.set('ee', { type: 'app' })
  reg.recordAnchorCheck('ee')
  const e = reg.get('ee')
  t.ok(e.lastAnchorCheck > 0, 'recorded timestamp')
  t.is(e.anchored, false, 'state unchanged')
})

test('AppRegistry — anchorStats aggregates correctly', (t) => {
  const { dir, cleanup } = tmpDir()
  t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  reg.set('a1', { type: 'app' })
  reg.set('a2', { type: 'app' })
  reg.set('a3', { type: 'app' })
  reg.setAnchored('a1', 10)
  reg.recordAnchorCheck('a2') // checked but not anchored
  // a3 never checked
  const stats = reg.anchorStats()
  t.is(stats.total, 3)
  t.is(stats.anchored, 1)
  t.is(stats.unanchored, 2)
  t.is(stats.neverChecked, 1)
})

test('AppRegistry — catalog() exposes anchored / anchoredAt / anchoredLength', (t) => {
  const { dir, cleanup } = tmpDir()
  t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  reg.set('ff', { type: 'app' })
  reg.setAnchored('ff', 7)
  const items = reg.catalog()
  const item = items.find(i => i.appKey === 'ff')
  t.is(item.anchored, true)
  t.is(item.anchoredLength, 7)
  t.ok(item.anchoredAt > 0)
})

test('AppRegistry — anchor state survives save/reload', async (t) => {
  const { dir, cleanup } = tmpDir()
  t.teardown(cleanup)
  const reg1 = new AppRegistry(dir)
  reg1.set('gg', { type: 'app' })
  reg1.setAnchored('gg', 99)
  await reg1.save()

  const reg2 = new AppRegistry(dir)
  await reg2.load()
  const e = reg2.get('gg')
  t.is(e.anchored, true, 'anchored persisted')
  t.is(e.anchoredLength, 99, 'length persisted')
  t.ok(e.anchoredAt > 0, 'anchoredAt persisted')
})

test('AppRegistry — setAnchored on missing entry returns false', (t) => {
  const { dir, cleanup } = tmpDir()
  t.teardown(cleanup)
  const reg = new AppRegistry(dir)
  t.is(reg.setAnchored('nope', 1), false)
})
