/**
 * Run drive.update() / drive.download() with a hard timeout that *actually*
 * cancels the underlying Hypercore upgrade / block requests when it fires.
 *
 * Background: the previous eagerReplicate retry loop wrapped
 * `drive.update({ wait: true })` in a Promise.race with a setTimeout-reject.
 * When the timeout fired, the surrounding code got control back — but the
 * underlying hypercore upgrade request was still attached to the
 * replicator's activeRequests array, holding a pending promise and an
 * upgrade ref. Over time, repeated calls (or repeated retries within one
 * call) leaked a growing pool of these refs, which is the suspected
 * root cause of the "Cannot make sessions on a closing core" symptom
 * that PR #14 (v0.8.7) papered over with a 503 + Retry-After response.
 *
 * Fix: pass our own `activeRequests = []` array into hypercore's update().
 * On timeout (or any rejection), call
 *
 *   drive.db.core.replicator.clearRequests(activeRequests, err)
 *
 * which walks the array and properly detaches + rejects every ref, then
 * triggers an updateAll() so the replicator knows to stop pursuing the
 * upgrade. This is hypercore's documented(-by-convention) cancellation
 * API; see node_modules/hypercore/lib/replicator.js:1660.
 *
 * For downloads, hyperdrive returns a download tracker on which we call
 * `.destroy()` on timeout — `.done()` returning has no cleanup but
 * `.destroy()` cancels the underlying block requests.
 */

const DEFAULT_UPDATE_TIMEOUT_MS = 30_000
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000

/**
 * Race drive.update(opts) against a timeout. If the timeout fires first,
 * cancel any in-flight upgrade requests so they don't leak.
 *
 * @param {object} drive — Hyperdrive instance
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] — abort after this many ms (default 30s)
 * @param {boolean} [opts.wait] — passed through to drive.update (default true)
 * @returns {Promise<boolean>} — hypercore.update's return value, or throws
 *   if the timeout fires before update settles
 */
export async function updateWithTimeout (drive, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_UPDATE_TIMEOUT_MS
  const wait = opts.wait !== false
  const activeRequests = []

  let timer = null
  let timedOut = false

  const updatePromise = drive.update({ wait, activeRequests })

  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        // Cancel any in-flight upgrade refs sitting in our activeRequests
        // array. This is the hypercore-documented way to abort an update.
        const replicator = drive.db && drive.db.core && drive.db.core.replicator
        if (replicator && typeof replicator.clearRequests === 'function') {
          try {
            replicator.clearRequests(activeRequests, new Error('UPDATE_TIMEOUT'))
          } catch {
            // Replicator might be torn down already; ignore.
          }
        }
        reject(new Error('update timeout'))
      }, timeoutMs)
      // We deliberately don't .unref() the timer — brittle's deadlock
      // detector treats unref'd timers as "no pending work" and aborts
      // tests prematurely. Timers are short (30s default) and clearTimeout
      // fires in every resolution path, so production behavior is fine.

      updatePromise.then(
        (value) => {
          if (!timedOut) {
            clearTimeout(timer)
            resolve(value)
          }
        },
        (err) => {
          if (!timedOut) {
            clearTimeout(timer)
            reject(err)
          }
        }
      )
    })
  } finally {
    if (timer) clearTimeout(timer)
    // Defensive: if for any reason a ref remained in our array (e.g. the
    // updatePromise resolved at the same instant the timer fired), make
    // sure nothing leaks. clearRequests on an empty array is a no-op.
    const replicator = drive.db && drive.db.core && drive.db.core.replicator
    if (replicator && typeof replicator.clearRequests === 'function' && activeRequests.length > 0) {
      try { replicator.clearRequests(activeRequests, new Error('UPDATE_CANCELLED')) } catch {}
    }
  }
}

/**
 * Race a drive download against a timeout. On timeout, destroy the
 * download tracker so its in-flight block requests are released.
 *
 * @param {object} drive — Hyperdrive instance
 * @param {string} [path] — path to download (default '/')
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] — abort after this many ms (default 120s)
 * @returns {Promise<void>}
 */
export async function downloadWithTimeout (drive, path = '/', opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_DOWNLOAD_TIMEOUT_MS
  // drive.download() throws synchronously if the drive is closing;
  // let that bubble up so the caller can handle it the same way it
  // would have without the timeout wrapper.
  const dl = drive.download(path)

  let timer = null
  let timedOut = false

  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        try { dl.destroy() } catch { /* best-effort */ }
        reject(new Error('download timeout'))
      }, timeoutMs)
      // No .unref() — see updateWithTimeout for the brittle-deadlock note.

      dl.done().then(
        () => {
          if (!timedOut) {
            clearTimeout(timer)
            resolve()
          }
        },
        (err) => {
          if (!timedOut) {
            clearTimeout(timer)
            reject(err)
          }
        }
      )
    })
  } finally {
    if (timer) clearTimeout(timer)
    // Defensive: destroy() is idempotent on hyperdrive download trackers.
    if (dl && typeof dl.destroy === 'function') {
      try { dl.destroy() } catch {}
    }
  }
}

export const UPDATE_TIMEOUT_MS = DEFAULT_UPDATE_TIMEOUT_MS
export const DOWNLOAD_TIMEOUT_MS = DEFAULT_DOWNLOAD_TIMEOUT_MS
