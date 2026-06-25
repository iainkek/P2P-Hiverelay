// hand-eval.js — 7-card Texas Hold'em hand evaluator (money layer, Phase 02).
//
// Pure, deterministic, runtime-portable (Node + Bare). Used by the settlement
// reducer to determine winners at showdown so the payout is computed — never
// declared/trusted. No dependencies.
//
// Card encoding (the money-layer convention; the dealing layer MUST match):
//   card ∈ [0,51];  rank = Math.floor(card / 4) ∈ [0,12]  (0=2,1=3,…,8=T,9=J,10=Q,11=K,12=A)
//   suit = card % 4 ∈ [0,3]
//
// evaluate7(cards7) → rank array [category, ...tiebreakers], compared
// lexicographically (higher = better). Category: 8 straight-flush, 7 quads,
// 6 full house, 5 flush, 4 straight, 3 trips, 2 two-pair, 1 pair, 0 high-card.

export const RANK = { CATEGORY: { HIGH: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4, FLUSH: 5, FULL_HOUSE: 6, QUADS: 7, STRAIGHT_FLUSH: 8 } }

export function cardRank (card) { return Math.floor(card / 4) }
export function cardSuit (card) { return card % 4 }

/** Compare two rank arrays. >0 if a beats b, <0 if b beats a, 0 if tie. */
export function compareRank (a, b) {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? -1
    const y = b[i] ?? -1
    if (x !== y) return x - y
  }
  return 0
}

// Best straight high-card from a set of distinct ranks (Ace plays high or low).
// Returns the high rank of the straight, or -1 if none. Wheel (A-2-3-4-5) → 3.
function straightHigh (rankSet) {
  // Ace (12) can also be low (-1) for the wheel.
  const present = new Set(rankSet)
  if (present.has(12)) present.add(-1)
  const sorted = [...present].sort((a, b) => b - a)
  let run = 1
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i] - 1 === sorted[i + 1]) {
      run++
      if (run >= 5) return sorted[i - 3]
    } else {
      run = 1
    }
  }
  return -1
}

/** Evaluate exactly 5 cards → rank array. */
export function evaluate5 (cards) {
  const ranks = cards.map(cardRank)
  const suits = cards.map(cardSuit)
  const isFlush = suits.every(s => s === suits[0])

  const counts = new Map()
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1)
  // groups sorted by (count desc, rank desc)
  const groups = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]))
  const sHigh = straightHigh(ranks)
  const ranksDesc = [...ranks].sort((a, b) => b - a)

  const C = RANK.CATEGORY
  if (isFlush && sHigh >= 0) return [C.STRAIGHT_FLUSH, sHigh]
  if (groups[0][1] === 4) return [C.QUADS, groups[0][0], groups[1][0]]
  if (groups[0][1] === 3 && groups[1] && groups[1][1] >= 2) return [C.FULL_HOUSE, groups[0][0], groups[1][0]]
  if (isFlush) return [C.FLUSH, ...ranksDesc]
  if (sHigh >= 0) return [C.STRAIGHT, sHigh]
  if (groups[0][1] === 3) {
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a, b) => b - a)
    return [C.TRIPS, groups[0][0], ...kickers]
  }
  if (groups[0][1] === 2 && groups[1] && groups[1][1] === 2) {
    const hi = Math.max(groups[0][0], groups[1][0])
    const lo = Math.min(groups[0][0], groups[1][0])
    const kicker = groups.find(g => g[1] === 1)[0]
    return [C.TWO_PAIR, hi, lo, kicker]
  }
  if (groups[0][1] === 2) {
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a, b) => b - a)
    return [C.PAIR, groups[0][0], ...kickers]
  }
  return [C.HIGH, ...ranksDesc]
}

// All C(7,5)=21 index combinations.
const COMBOS_7_5 = (() => {
  const out = []
  for (let a = 0; a < 7; a++) {
    for (let b = a + 1; b < 7; b++) {
      const pick = []
      for (let i = 0; i < 7; i++) if (i !== a && i !== b) pick.push(i)
      out.push(pick)
    }
  }
  return out
})()

/**
 * Best 5-card rank from 7 cards (2 hole + 5 board).
 * @param {number[]} cards7
 * @returns {number[]} rank array
 */
export function evaluate7 (cards7) {
  if (!Array.isArray(cards7) || cards7.length !== 7) throw new Error('evaluate7: need exactly 7 cards')
  let best = null
  for (const combo of COMBOS_7_5) {
    const r = evaluate5(combo.map(i => cards7[i]))
    if (best === null || compareRank(r, best) > 0) best = r
  }
  return best
}
