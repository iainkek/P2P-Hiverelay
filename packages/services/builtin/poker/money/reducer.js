// reducer.js — canonical session-settlement reducer (money layer, Phase 02).
//
// Pure, deterministic, runtime-portable. Turns a session's hands into the net
// balances the escrow settles, and a `sessionHash` both HiveRelay (to attest)
// and the client (to verify) compute identically. This is the single source of
// truth for "who is owed what" — winners are COMPUTED from revealed cards via
// hand-eval, never trusted from a declared `settle`. See
// .planning/phases/01-escrow-settlement-spike/interfaces.md (reducer contract).
//
// Input (normalized by the betting engine, Phase 09):
//   reduce({ seats, hands }) where
//     seats: string[]                         // canonical participant set (settlement ids), e.g. addresses
//     hands: Hand[] where Hand = {
//       handId:        string
//       board:         number[]               // 0..5 community cards (5 at showdown)
//       contributions: { [seat]: integer }    // chips each seat committed this hand (≥0)
//       folded:        string[]               // seats that folded (ineligible at showdown)
//       reveals:       { [seat]: [number, number] }  // hole cards for non-folded seats
//     }
// Output: { sessionHash, balances: {seat:int}, perHand: [...], illegal: null | {reason, handId} }
//   - balances sum to 0 (conservation invariant).
//   - illegal != null ⇒ the log is rejected and balances/sessionHash are null.

import sodium from 'sodium-universal'
import b4a from 'b4a'
import { evaluate7, compareRank } from './hand-eval.js'

function canonical (value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function sha256Hex (str) {
  const out = b4a.alloc(32)
  sodium.crypto_hash_sha256(out, b4a.from(str, 'utf8'))
  return b4a.toString(out, 'hex')
}

const isInt = (n) => Number.isInteger(n)

/**
 * Distribute one hand's pot(s) to winners. Returns
 * { net: {seat:int}, potDistribution: {seat:int}, winners, error }.
 * Handles side pots (all-ins) and uncalled-bet refunds.
 */
function settleHand (hand, seatSet) {
  const contrib = {}
  for (const seat of seatSet) contrib[seat] = 0
  for (const [seat, amt] of Object.entries(hand.contributions || {})) {
    if (!seatSet.has(seat)) return { error: 'CONTRIB_UNKNOWN_SEAT' }
    if (!isInt(amt) || amt < 0) return { error: 'CONTRIB_BAD_AMOUNT' }
    contrib[seat] = amt
  }
  const folded = new Set(hand.folded || [])
  const active = [...seatSet].filter(s => contrib[s] > 0)
  const eligible = active.filter(s => !folded.has(s)) // can win

  // Effective contributions: cap a lone top contributor to the 2nd-highest
  // (uncalled bet is refunded, never entered into a pot).
  const eff = { ...contrib }
  const amts = active.map(s => contrib[s]).sort((a, b) => b - a)
  if (amts.length >= 2 && amts[0] > amts[1]) {
    const top = active.filter(s => contrib[s] === amts[0])
    if (top.length === 1) eff[top[0]] = amts[1] // refund the uncalled excess
  } else if (amts.length === 1) {
    // Only one seat put money in → it's all uncalled; pot is just their own.
    // eff stays; they are the sole contender (or fold-win below).
  }

  const totalPot = Object.values(eff).reduce((a, b) => a + b, 0)
  const winnings = {}
  for (const seat of seatSet) winnings[seat] = 0

  // Fold-win: exactly one eligible seat → wins the whole pot uncontested.
  if (eligible.length === 1) {
    winnings[eligible[0]] = totalPot
    return finalize(seatSet, eff, winnings)
  }
  if (eligible.length === 0) {
    // Everyone folded (shouldn't happen in a real hand) → refund each their eff.
    for (const seat of seatSet) winnings[seat] = eff[seat]
    return finalize(seatSet, eff, winnings)
  }

  // Need reveals + a 5-card board to evaluate contested pots.
  if (!Array.isArray(hand.board) || hand.board.length !== 5) return { error: 'BOARD_NOT_5' }
  for (const seat of eligible) {
    const hole = (hand.reveals || {})[seat]
    if (!Array.isArray(hole) || hole.length !== 2) return { error: 'MISSING_REVEAL:' + seat }
  }

  // Validate the deal: every card is an integer in [0,51] and GLOBALLY distinct
  // across the board and all revealed hole cards — no duplicate or out-of-range
  // card can reach the evaluator (a malformed/cheating reveal is rejected, not
  // silently mis-ranked).
  const seen = new Set()
  for (const c of [...hand.board, ...eligible.flatMap(s => hand.reveals[s])]) {
    if (!isInt(c) || c < 0 || c > 51) return { error: 'INVALID_DEAL:card_range' }
    if (seen.has(c)) return { error: 'INVALID_DEAL:duplicate' }
    seen.add(c)
  }

  // Pre-rank eligible hands once.
  const rankOf = {}
  for (const seat of eligible) {
    rankOf[seat] = evaluate7([...hand.reveals[seat], ...hand.board])
  }

  // Side pots by effective contribution level.
  const levels = [...new Set(active.map(s => eff[s]).filter(v => v > 0))].sort((a, b) => a - b)
  let prev = 0
  const orderedSeats = [...seatSet].sort() // deterministic odd-chip order
  for (const L of levels) {
    const layerContributors = active.filter(s => eff[s] >= L)
    const amount = (L - prev) * layerContributors.length
    prev = L
    if (amount <= 0) continue
    const contenders = eligible.filter(s => eff[s] >= L)
    if (contenders.length === 0) {
      // No eligible contender for this layer (all folded) → return to the
      // contributors of this layer proportionally (chips don't vanish).
      // With integer chips, distribute by canonical order, 1 each round.
      distributeEven(winnings, layerContributors.sort(), amount)
      continue
    }
    let best = null
    for (const s of contenders) best = best === null ? rankOf[s] : (compareRank(rankOf[s], best) > 0 ? rankOf[s] : best)
    const wins = contenders.filter(s => compareRank(rankOf[s], best) === 0).sort()
    distributeEven(winnings, wins.length ? wins : orderedSeats, amount)
  }

  return finalize(seatSet, eff, winnings)
}

// Split `amount` (integer) among `recipients` in canonical order; odd chips go
// to the earliest recipients (deterministic).
function distributeEven (winnings, recipients, amount) {
  const n = recipients.length
  const base = Math.floor(amount / n)
  let rem = amount - base * n
  for (const r of recipients) {
    winnings[r] += base + (rem > 0 ? 1 : 0)
    if (rem > 0) rem--
  }
}

function finalize (seatSet, eff, winnings) {
  const net = {}
  const potDistribution = {}
  for (const seat of seatSet) {
    net[seat] = (winnings[seat] || 0) - (eff[seat] || 0)
    if (winnings[seat]) potDistribution[seat] = winnings[seat]
  }
  return { net, potDistribution }
}

/**
 * Reduce a whole session to net balances + a deterministic sessionHash.
 * @param {{ seats: string[], hands: object[] }} session
 */
export function reduce (session) {
  if (!session || !Array.isArray(session.seats) || !Array.isArray(session.hands)) {
    return { illegal: { reason: 'BAD_SHAPE', handId: null }, balances: null, sessionHash: null, perHand: [] }
  }
  const seats = [...session.seats].map(String)
  const seatSet = new Set(seats)
  if (seatSet.size !== seats.length) return { illegal: { reason: 'DUP_SEAT', handId: null }, balances: null, sessionHash: null, perHand: [] }

  const balances = {}
  for (const seat of seats) balances[seat] = 0
  const perHand = []

  for (const hand of session.hands) {
    if (!hand || typeof hand.handId !== 'string') {
      return { illegal: { reason: 'BAD_HAND', handId: hand && hand.handId }, balances: null, sessionHash: null, perHand: [] }
    }
    const r = settleHand(hand, seatSet)
    if (r.error) return { illegal: { reason: r.error, handId: hand.handId }, balances: null, sessionHash: null, perHand: [] }
    // Conservation per hand.
    const sum = Object.values(r.net).reduce((a, b) => a + b, 0)
    if (sum !== 0) return { illegal: { reason: 'NOT_CONSERVED', handId: hand.handId }, balances: null, sessionHash: null, perHand: [] }
    for (const seat of seats) balances[seat] += r.net[seat]
    perHand.push({ handId: hand.handId, potDistribution: r.potDistribution })
  }

  const body = { seats: [...seats].sort(), balances, perHand }
  const sessionHash = sha256Hex(canonical(body))
  return { illegal: null, balances, sessionHash, perHand }
}
