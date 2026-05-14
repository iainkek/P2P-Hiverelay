/**
 * cancellable-drive-update tests.
 *
 * Verifies that updateWithTimeout() and downloadWithTimeout() actually
 * cancel the underlying hypercore upgrade requests / hyperdrive download
 * trackers when the timeout fires. The bug they fix is the leak where
 * Promise.race resolves on timeout but the underlying hypercore update
 * keeps its upgrade ref attached, leaking sessions over time.
 *
 * Tests use a mock Hyperdrive that exposes `activeRequests` and tracks
 * whether `clearRequests` got called. No real swarm needed.
 */

import test from 'brittle'
import { updateWithTimeout, downloadWithTimeout } from 'p2p-hiverelay/core/relay-node/cancellable-drive-update.js'

// Mock Hyperdrive that:
//   - exposes drive.db.core.replicator.clearRequests(activeRequests, err)
//   - records every clearRequests call so tests can assert
//   - drive.update(opts) returns a pending promise + pushes a fake "ref" into opts.activeRequests
function mockDrive ({ updateLatency = null, updateRejects = null, downloadLatency = null, downloadRejects = null } = {}) {
  const clearCalls = []
  const drive = {
    closed: false,
    closing: false,
    version: 1,
    db: {
      core: {
        replicator: {
          clearRequests (session, err) {
            clearCalls.push({ count: session.length, err })
            // Detach refs from the session (mirror real hypercore behavior)
            while (session.length > 0) {
              const ref = session.pop()
              if (ref && typeof ref.reject === 'function') ref.reject(err || new Error('cancelled'))
            }
          }
        }
      }
    },
    update (opts) {
      // Push a fake ref into activeRequests so the cancellation path has
      // something to detach. Real hypercore pops the ref on resolve/reject
      // via Attachable._detach; the mock mirrors that so a clean update()
      // resolution leaves activeRequests empty.
      return new Promise((resolve, reject) => {
        const arr = (opts && Array.isArray(opts.activeRequests)) ? opts.activeRequests : null
        const ref = {
          resolve: (v) => {
            if (arr) {
              const i = arr.indexOf(ref)
              if (i >= 0) arr.splice(i, 1)
            }
            resolve(v)
          },
          reject: (e) => {
            if (arr) {
              const i = arr.indexOf(ref)
              if (i >= 0) arr.splice(i, 1)
            }
            reject(e)
          }
        }
        if (arr) arr.push(ref)
        if (updateLatency !== null) {
          setTimeout(() => ref.resolve(true), updateLatency).unref?.()
        } else if (updateRejects) {
          setTimeout(() => ref.reject(updateRejects), 5).unref?.()
        }
        // Otherwise hang forever (simulates a real drive.update waiting
        // for an upgrade that never comes).
      })
    },
    download () {
      let destroyed = false
      return {
        destroy () { destroyed = true },
        get destroyed () { return destroyed },
        done () {
          return new Promise((resolve, reject) => {
            if (downloadLatency !== null) {
              setTimeout(() => resolve(undefined), downloadLatency).unref?.()
            } else if (downloadRejects) {
              setTimeout(() => reject(downloadRejects), 5).unref?.()
            }
            // Otherwise hang
          })
        }
      }
    }
  }
  return { drive, clearCalls }
}

// ─── updateWithTimeout ──────────────────────────────────────────────

test('updateWithTimeout: resolves when update completes before timeout', async (t) => {
  const { drive, clearCalls } = mockDrive({ updateLatency: 10 })
  const result = await updateWithTimeout(drive, { timeoutMs: 1000 })
  t.is(result, true)
  t.is(clearCalls.length, 0, 'no cancel called on success')
})

test('updateWithTimeout: rejects + calls clearRequests on timeout', async (t) => {
  const { drive, clearCalls } = mockDrive() // update hangs forever
  try {
    await updateWithTimeout(drive, { timeoutMs: 50 })
    t.fail('should have timed out')
  } catch (err) {
    t.is(err.message, 'update timeout')
  }
  // Allow microtasks to settle so the finally-block clearRequests fires.
  await new Promise(resolve => setImmediate(resolve))
  t.ok(clearCalls.length >= 1, 'clearRequests called on timeout')
  // Critical: the ref was actually drained
  const lastCall = clearCalls[clearCalls.length - 1]
  t.ok(lastCall.err && lastCall.err.message, 'clearRequests passed an error')
})

test('updateWithTimeout: propagates non-timeout rejections cleanly', async (t) => {
  const { drive } = mockDrive({ updateRejects: new Error('network down') })
  try {
    await updateWithTimeout(drive, { timeoutMs: 1000 })
    t.fail('should have rejected')
  } catch (err) {
    t.is(err.message, 'network down')
  }
  // No timeout happened, so clearRequests may or may not have been called
  // depending on whether the ref was detached by the rejection. Either is
  // acceptable; what matters is no LEAK.
})

test('updateWithTimeout: tolerates missing replicator without crashing', async (t) => {
  // Drive without db.core.replicator — older hypercore, mocked corestore, etc.
  const drive = {
    db: {},
    update: () => new Promise(() => {})
  }
  try {
    await updateWithTimeout(drive, { timeoutMs: 50 })
    t.fail('should have timed out')
  } catch (err) {
    t.is(err.message, 'update timeout')
    // Just verify we didn't crash on the missing replicator
  }
})

test('updateWithTimeout: clears the active-requests array on timeout', async (t) => {
  const { drive, clearCalls } = mockDrive() // hangs
  let captured = null
  // Wrap update to capture the activeRequests array
  const origUpdate = drive.update.bind(drive)
  drive.update = (opts) => {
    captured = opts.activeRequests
    return origUpdate(opts)
  }

  try { await updateWithTimeout(drive, { timeoutMs: 30 }) } catch {}
  await new Promise(resolve => setImmediate(resolve))

  t.ok(captured, 'activeRequests was passed to update()')
  t.is(captured.length, 0, 'activeRequests array drained after timeout')
  t.ok(clearCalls.length >= 1, 'clearRequests was called at least once')
})

// ─── downloadWithTimeout ────────────────────────────────────────────

test('downloadWithTimeout: resolves when download completes before timeout', async (t) => {
  const { drive } = mockDrive({ downloadLatency: 10 })
  await downloadWithTimeout(drive, '/', { timeoutMs: 1000 })
  t.pass('download completed')
})

test('downloadWithTimeout: rejects + destroys tracker on timeout', async (t) => {
  const { drive } = mockDrive() // download hangs
  let trackerRef = null
  const origDownload = drive.download.bind(drive)
  drive.download = (path) => {
    trackerRef = origDownload(path)
    return trackerRef
  }
  try {
    await downloadWithTimeout(drive, '/', { timeoutMs: 50 })
    t.fail('should have timed out')
  } catch (err) {
    t.is(err.message, 'download timeout')
  }
  t.ok(trackerRef.destroyed, 'download tracker was destroyed on timeout')
})

test('downloadWithTimeout: propagates download() construction errors', async (t) => {
  const drive = {
    download () { throw new Error('drive closed') }
  }
  try {
    await downloadWithTimeout(drive, '/', { timeoutMs: 100 })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'drive closed')
  }
})

test('downloadWithTimeout: defensive destroy on rejection path', async (t) => {
  const { drive } = mockDrive({ downloadRejects: new Error('replication failed') })
  let trackerRef = null
  const origDownload = drive.download.bind(drive)
  drive.download = (path) => {
    trackerRef = origDownload(path)
    return trackerRef
  }
  try {
    await downloadWithTimeout(drive, '/', { timeoutMs: 1000 })
    t.fail('should have rejected')
  } catch (err) {
    t.is(err.message, 'replication failed')
  }
  // The finally-block destroys defensively even on reject paths
  t.ok(trackerRef.destroyed, 'tracker destroyed by defensive cleanup')
})
