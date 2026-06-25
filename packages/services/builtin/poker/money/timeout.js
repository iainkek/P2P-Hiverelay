// timeout.js — objective settlement deadlines (money layer, Phase 05).
//
// "Player X missed the showdown reveal / co-sign window" must be NON-subjective
// so the dispute path can act on a stall (vs a cheat). The signed log's `ts`
// (relay-clock-bounded to ±60s by SignedLog) anchors the deadline:
//   deadline = triggerTs + graceMs
// A seat that has not posted the required entry by the deadline — judged once
// `now` is past it — is overdue. Overdue actors feed the forfeit path
// (arbitration 'refused-reveal' / arbitration-bridge.applyVerdict).
//
// Pure; no clock of its own — `now` and `triggerTs` come from signed sources.

/**
 * @param {object} args
 * @param {object[]} args.entries       signed-log entries ({ writer, ts, payload })
 * @param {string[]} args.expectedFrom  seats obligated to act
 * @param {string} args.expectedKind    payload.kind that satisfies the obligation (e.g. 'reveal', 'cosign')
 * @param {number} args.triggerTs       when the obligation started (a signed entry's ts)
 * @param {number} args.graceMs         allowed window
 * @param {number} args.now             current signed/relay time
 * @returns {{ deadline:number, expired:boolean, overdue:string[] }}
 */
export function settlementStatus ({ entries, expectedFrom, expectedKind, triggerTs, graceMs, now }) {
  if (!Array.isArray(expectedFrom) || !Number.isFinite(triggerTs) || !Number.isFinite(graceMs) || !Number.isFinite(now)) {
    throw new Error('settlementStatus: bad args')
  }
  const deadline = triggerTs + graceMs
  const acted = new Set()
  for (const e of entries || []) {
    if (!e || typeof e.ts !== 'number') continue
    if (e.ts > deadline) continue // posted too late — does not satisfy the deadline
    if (e.payload && e.payload.kind === expectedKind && expectedFrom.includes(e.writer)) acted.add(e.writer)
  }
  const expired = now > deadline
  return { deadline, expired, overdue: expired ? expectedFrom.filter(s => !acted.has(s)) : [] }
}
