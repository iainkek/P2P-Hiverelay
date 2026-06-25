// arbitration-bridge.js — turns a resolved arbitration verdict into a corrected
// settlement (money layer, Phase 04).
//
// The relay arbitration service (builtin/arbitration-service.js) resolves poker
// cheating disputes (missing-share / invalid-share / refused-reveal) to a
// verdict: 'claimant' (the accuser wins → the RESPONDENT cheated) or
// 'respondent' (the respondent is exonerated). This bridge maps a guilty
// verdict onto the settlement: the cheater FORFEITS the disputed hand (treated
// as folded), and the reducer re-settles the pot to the honest player(s). The
// cheater additionally loses their bond via the arbitration service's own
// slashing — that is reputation/stake, separate from this in-hand forfeit.
//
// Pure: returns a corrected session for reduce(); no I/O.

/**
 * Apply a resolved arbitration verdict to a session.
 * @param {{ seats:string[], hands:object[] }} session
 * @param {{ respondent:string, verdict:'claimant'|'respondent', handId?:string }} verdict
 * @returns {{ seats, hands }} corrected session (unchanged if exonerated)
 */
export function applyVerdict (session, verdict) {
  if (!session || !Array.isArray(session.hands)) return session
  if (!verdict || verdict.verdict !== 'claimant' || !verdict.respondent) return session
  const guilty = verdict.respondent
  return {
    seats: session.seats,
    hands: session.hands.map(h => {
      if (verdict.handId && h.handId !== verdict.handId) return h
      const folded = [...new Set([...(h.folded || []), guilty])]
      // The cheater can't be the revealed winner; drop their reveal too so a
      // re-reduce never evaluates a forfeited hand.
      const reveals = { ...(h.reveals || {}) }
      delete reveals[guilty]
      return { ...h, folded, reveals }
    })
  }
}
