// betting.js — No-Limit Hold'em betting engine (money layer, Phase 09).
//
// Pure, deterministic, dependency-free (Node + Bare + browser). The legal-betting
// + pot-accounting authority. It does NOT deal cards or evaluate hands — side-pot
// SPLITTING lives in reducer.js; this engine produces per-seat totals + folded.
//
// Supports N ≥ 2 (heads-up and multiway, up to a full ring). Blind/turn rules:
//   - Heads-up (N=2): button posts SB and acts first pre-flop; BB acts first
//     post-flop and holds the pre-flop option.
//   - N ≥ 3: SB = button+1, BB = button+2; UTG (button+3) acts first pre-flop;
//     first active seat left of the button acts first post-flop.
//
// Two ways to use it, ONE engine underneath:
//
//   1. Stream validator (the settlement authority):
//        playHand(config, actions) → { contributions, folded, complete, showdown, street, illegal }
//
//   2. Interactive driver (for a UI — same logic, turn-by-turn):
//        const S = createHand(config)        // live state, or { illegal }
//        legalActions(S)                     // what the current actor may do
//        applyAction(S, { seat, type, amount? })  // mutate S, or { illegal }
//        view(S)                             // public snapshot for rendering
//
// Action: { seat, type, amount? }, type ∈ 'fold'|'check'|'call'|'bet'|'raise'|'allin'.
// For 'bet'/'raise', `amount` is the TOTAL committed THIS STREET after the action.

const STREETS = ['preflop', 'flop', 'turn', 'river']

function bad (reason, detail) {
  return { illegal: { reason, detail: detail ?? null }, contributions: null, folded: null }
}
const ill = (reason, detail) => ({ illegal: { reason, detail: detail ?? null } })

// ── internal state machine (shared by playHand + the interactive API) ──

function put (S, s, amt) {
  const a = Math.min(amt, S.stack[s])
  S.stack[s] -= a; S.total[s] += a; S.street[s] += a
  if (S.stack[s] === 0) S.allIn.add(s)
  return a
}
const activeSeats = (S) => S.seats.filter(s => !S.folded.has(s))
const canActSeats = (S) => S.seats.filter(s => !S.folded.has(s) && !S.allIn.has(s))
function nextCanAct (S, fromIdx) {
  for (let k = 1; k <= S.N; k++) { const idx = (fromIdx + k) % S.N; const s = S.seats[idx]; if (!S.folded.has(s) && !S.allIn.has(s)) return idx }
  return -1
}
function firstCanActFrom (S, fromIdx) {
  for (let k = 0; k < S.N; k++) { const idx = (fromIdx + k) % S.N; const s = S.seats[idx]; if (!S.folded.has(s) && !S.allIn.has(s)) return idx }
  return -1
}
const allMatched = (S, set) => set.every(s => S.street[s] === S.currentBet)

function closeStreet (S) {
  if (S.streetIdx === STREETS.length - 1) { S.complete = true; S.showdown = true; return }
  S.streetIdx++
  for (const s of S.seats) S.street[s] = 0
  S.currentBet = 0; S.minRaise = S.blinds.bb
  S.acted = new Set()
  const fi = firstCanActFrom(S, S.firstPostBase)
  if (fi < 0) { S.complete = true; S.showdown = true; return } // everyone all-in → run out
  S.toActIdx = fi
}

// ≤1 player can still act and bets are matched → no further betting is possible;
// deal the remaining streets straight to showdown.
function runOut (S) { while (!S.complete) closeStreet(S) }

// Resolve table state after an action: hand over, run out, advance, or close.
function resolve (S, actorIdx) {
  if (S.complete) return
  if (activeSeats(S).length === 1) { S.complete = true; S.showdown = false; return }
  const ca = canActSeats(S)
  if (ca.length <= 1) {
    if (allMatched(S, ca)) { runOut(S) } else { S.toActIdx = nextCanAct(S, actorIdx) }
    return
  }
  if (allMatched(S, ca) && ca.every(s => S.acted.has(s))) { closeStreet(S); return }
  S.toActIdx = nextCanAct(S, actorIdx)
}

/**
 * Start a hand: validate config, post blinds, resolve the opening state.
 * @returns a live state object, or { illegal: { reason, detail } } on bad config.
 */
export function createHand (config) {
  if (!config || !Array.isArray(config.seats) || config.seats.length < 2) return ill('NEED_2_SEATS')
  const { seats, stacks, blinds, button } = config
  const N = seats.length
  const bIdx = seats.indexOf(button)
  if (bIdx < 0) return ill('BAD_BUTTON')
  if (!stacks || seats.some(s => !(stacks[s] > 0))) return ill('BAD_STACKS')
  if (!blinds || !(blinds.bb > 0) || !(blinds.sb > 0)) return ill('BAD_BLINDS')
  if (new Set(seats).size !== N) return ill('DUP_SEAT')

  const sbIdx = N === 2 ? bIdx : (bIdx + 1) % N
  const bbIdx = N === 2 ? (bIdx + 1) % N : (bIdx + 2) % N
  const firstPreIdx = N === 2 ? sbIdx : (bIdx + 3) % N
  const firstPostBase = N === 2 ? bbIdx : sbIdx

  const S = {
    seats: [...seats],
    N,
    blinds: { sb: blinds.sb, bb: blinds.bb },
    bIdx,
    sbIdx,
    bbIdx,
    firstPreIdx,
    firstPostBase,
    stack: {},
    total: {},
    street: {},
    folded: new Set(),
    allIn: new Set(),
    currentBet: blinds.bb,
    minRaise: blinds.bb,
    streetIdx: 0,
    toActIdx: firstPreIdx,
    acted: new Set(),
    complete: false,
    showdown: false
  }
  for (const s of seats) { S.stack[s] = stacks[s]; S.total[s] = 0; S.street[s] = 0 }
  put(S, seats[sbIdx], blinds.sb)
  put(S, seats[bbIdx], blinds.bb)
  // Opening resolve: a seat all-in from a sub-blind is first-to-act but cannot
  // act — advance, or deal straight to showdown if nobody can act.
  {
    const fi = firstCanActFrom(S, firstPreIdx)
    const ca = canActSeats(S)
    if (fi < 0 || (ca.length <= 1 && allMatched(S, ca))) runOut(S)
    else S.toActIdx = fi
  }
  return S
}

/**
 * Apply one action to a live state, mutating it. Returns null on success, or
 * { illegal: { reason, detail } } if the action is not legal (state unchanged).
 * `i` is an optional action index used only in error detail.
 */
export function applyAction (S, act, i) {
  if (S.complete) return ill('ACTION_AFTER_COMPLETE', i ?? null)
  if (!act || act.seat !== S.seats[S.toActIdx]) return ill('OUT_OF_TURN', { i: i ?? null, expected: S.seats[S.toActIdx], got: act && act.seat })
  if (S.folded.has(act.seat) || S.allIn.has(act.seat)) return ill('CANNOT_ACT', act.seat)
  const seat = act.seat
  const owe = S.currentBet - S.street[seat]

  switch (act.type) {
    case 'fold':
      S.folded.add(seat)
      break
    case 'check':
      if (owe !== 0) return ill('CANNOT_CHECK_FACING_BET', i ?? null)
      S.acted.add(seat)
      break
    case 'call':
      if (owe <= 0) return ill('NOTHING_TO_CALL', i ?? null)
      put(S, seat, owe)
      S.acted.add(seat)
      break
    case 'bet':
    case 'raise': {
      const to = act.amount
      if (!Number.isInteger(to)) return ill('BAD_AMOUNT', i ?? null)
      if (act.type === 'bet' && S.currentBet !== 0) return ill('BET_WHEN_FACING_BET', i ?? null)
      if (act.type === 'raise' && S.currentBet === 0) return ill('RAISE_WITH_NO_BET', i ?? null)
      // Incomplete-raise rule: a player who has already acted since the last FULL
      // raise may only call/fold when an incomplete all-in bumps the bet.
      if (act.type === 'raise' && S.acted.has(seat)) return ill('RAISE_NOT_REOPENED', i ?? null)
      if (to <= S.currentBet) return ill('RAISE_NOT_HIGHER', i ?? null)
      const need = to - S.street[seat]
      if (need > S.stack[seat]) return ill('EXCEEDS_STACK', i ?? null)
      const raiseBy = to - S.currentBet
      const allInNow = need >= S.stack[seat]
      if (raiseBy < S.minRaise && !allInNow) return ill('BELOW_MIN_RAISE', { i: i ?? null, minRaise: S.minRaise, raiseBy })
      put(S, seat, need)
      S.minRaise = Math.max(S.minRaise, raiseBy)
      S.currentBet = S.street[seat]
      S.acted = new Set([seat]) // re-opens action for everyone else
      break
    }
    case 'allin': {
      if (S.stack[seat] === 0) return ill('NOTHING_TO_ALLIN', i ?? null)
      put(S, seat, S.stack[seat])
      if (S.street[seat] > S.currentBet) {
        const raiseBy = S.street[seat] - S.currentBet
        const fullRaise = raiseBy >= S.minRaise
        S.currentBet = S.street[seat]
        S.minRaise = Math.max(S.minRaise, raiseBy)
        // Only a FULL raise reopens betting (resets `acted`).
        if (fullRaise) S.acted = new Set([seat])
      } else {
        S.acted.add(seat)
      }
      break
    }
    default:
      return ill('UNKNOWN_ACTION', act.type)
  }
  resolve(S, S.toActIdx)
  return null
}

/**
 * What the current actor may legally do — derived to match applyAction exactly,
 * so a UI never offers an illegal move. Returns null if the hand is complete.
 */
export function legalActions (S) {
  if (S.complete) return null
  const seat = S.seats[S.toActIdx]
  const stack = S.stack[seat]
  const owe = S.currentBet - S.street[seat]
  const maxRaiseTo = S.street[seat] + stack
  const minRaiseTo = Math.min(S.currentBet + S.minRaise, maxRaiseTo)
  return {
    seat,
    owe,
    canFold: true,
    canCheck: owe === 0,
    canCall: owe > 0 && stack > 0,
    callAmount: Math.min(owe, stack),
    canBet: S.currentBet === 0 && stack > 0,
    canRaise: S.currentBet > 0 && !S.acted.has(seat) && stack > owe,
    minRaiseTo,
    maxRaiseTo,
    canAllin: stack > 0
  }
}

/** A public, render-ready snapshot of the live state. */
export function view (S) {
  return {
    toAct: S.complete ? null : S.seats[S.toActIdx],
    button: S.seats[S.bIdx],
    currentBet: S.currentBet,
    minRaise: S.minRaise,
    streetIdx: S.streetIdx,
    street: STREETS[S.streetIdx],
    complete: S.complete,
    showdown: S.showdown,
    pot: S.seats.reduce((a, s) => a + S.total[s], 0),
    seats: S.seats.map(s => ({ seat: s, stack: S.stack[s], bet: S.street[s], committed: S.total[s], folded: S.folded.has(s), allIn: S.allIn.has(s) })),
    contributions: { ...S.total },
    folded: [...S.folded]
  }
}

/**
 * Validate a complete action stream → settlement-ready result. Built on the same
 * state machine as the interactive API, so behaviour is identical.
 */
export function playHand (config, actions) {
  if (!Array.isArray(actions)) {
    // Preserve original validation order: seats/button before BAD_ACTIONS.
    if (!config || !Array.isArray(config.seats) || config.seats.length < 2) return bad('NEED_2_SEATS')
    if (!config.seats || config.seats.indexOf(config.button) < 0) return bad('BAD_BUTTON')
    return bad('BAD_ACTIONS')
  }
  const S = createHand(config)
  if (S.illegal) return bad(S.illegal.reason, S.illegal.detail)
  for (let i = 0; i < actions.length; i++) {
    if (S.complete) return bad('ACTION_AFTER_COMPLETE', i)
    const r = applyAction(S, actions[i], i)
    if (r && r.illegal) return bad(r.illegal.reason, r.illegal.detail)
  }
  return {
    contributions: { ...S.total },
    folded: [...S.folded],
    complete: S.complete,
    showdown: S.showdown,
    street: STREETS[S.streetIdx],
    illegal: null
  }
}
