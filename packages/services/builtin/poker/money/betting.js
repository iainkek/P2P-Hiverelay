// betting.js — No-Limit Hold'em betting engine (money layer, Phase 09).
//
// Pure, deterministic. Validates a raw action stream and produces the
// { contributions, folded } a hand needs for the settlement reducer. It does
// NOT deal cards or evaluate hands (mental-poker layer + reducer) — it is the
// legal-betting + pot-accounting authority. Side-pot SPLITTING lives in
// reducer.js; this engine just produces per-seat totals + the folded set.
//
// Supports N ≥ 2 (heads-up and multiway). Blind/turn-order rules:
//   - Heads-up (N=2): button posts SB and acts first pre-flop; BB acts first
//     post-flop and holds the pre-flop option.
//   - N ≥ 3: SB = button+1, BB = button+2; UTG (button+3) acts first pre-flop;
//     first active seat left of the button acts first post-flop.
//
// Action stream: [{ seat, type, amount? }] in turn order. type ∈
//   'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin'. For 'bet'/'raise',
//   `amount` is the TOTAL committed THIS STREET after the action (raise-to).
//
//   playHand(config, actions) → { contributions, folded, complete, showdown, street, illegal }

const STREETS = ['preflop', 'flop', 'turn', 'river']

function bad (reason, detail) {
  return { illegal: { reason, detail: detail ?? null }, contributions: null, folded: null }
}

export function playHand (config, actions) {
  if (!config || !Array.isArray(config.seats) || config.seats.length < 2) return bad('NEED_2_SEATS')
  const { seats, stacks, blinds, button } = config
  const N = seats.length
  const bIdx = seats.indexOf(button)
  if (bIdx < 0) return bad('BAD_BUTTON')
  if (!Array.isArray(actions)) return bad('BAD_ACTIONS')
  if (!stacks || seats.some(s => !(stacks[s] > 0))) return bad('BAD_STACKS')
  if (!blinds || !(blinds.bb > 0) || !(blinds.sb > 0)) return bad('BAD_BLINDS')
  if (new Set(seats).size !== N) return bad('DUP_SEAT')

  const sbIdx = N === 2 ? bIdx : (bIdx + 1) % N
  const bbIdx = N === 2 ? (bIdx + 1) % N : (bIdx + 2) % N
  const firstPreIdx = N === 2 ? sbIdx : (bIdx + 3) % N
  const firstPostBase = N === 2 ? bbIdx : sbIdx

  const stack = {}; const total = {}; const street = {}
  for (const s of seats) { stack[s] = stacks[s]; total[s] = 0; street[s] = 0 }
  const folded = new Set()
  const allIn = new Set()
  const put = (s, amt) => {
    const a = Math.min(amt, stack[s])
    stack[s] -= a; total[s] += a; street[s] += a
    if (stack[s] === 0) allIn.add(s)
    return a
  }

  put(seats[sbIdx], blinds.sb)
  put(seats[bbIdx], blinds.bb)
  let currentBet = blinds.bb
  let minRaise = blinds.bb
  let streetIdx = 0
  let toActIdx = firstPreIdx
  let acted = new Set() // acted since last aggression (blinds are NOT voluntary acts)
  let complete = false
  let showdown = false

  const activeSeats = () => seats.filter(s => !folded.has(s))
  const canActSeats = () => seats.filter(s => !folded.has(s) && !allIn.has(s))
  const nextCanAct = (fromIdx) => {
    for (let k = 1; k <= N; k++) {
      const idx = (fromIdx + k) % N
      const s = seats[idx]
      if (!folded.has(s) && !allIn.has(s)) return idx
    }
    return -1
  }
  const firstCanActFrom = (fromIdx) => {
    for (let k = 0; k < N; k++) {
      const idx = (fromIdx + k) % N
      const s = seats[idx]
      if (!folded.has(s) && !allIn.has(s)) return idx
    }
    return -1
  }
  const allMatched = (set) => set.every(s => street[s] === currentBet)

  function closeStreet () {
    if (streetIdx === STREETS.length - 1) { complete = true; showdown = true; return }
    streetIdx++
    for (const s of seats) street[s] = 0
    currentBet = 0; minRaise = blinds.bb
    acted = new Set()
    const fi = firstCanActFrom(firstPostBase)
    if (fi < 0) { complete = true; showdown = true; return } // everyone all-in → run out
    toActIdx = fi
  }

  // Resolve the table state after an action: hand over (one left), or run out
  // (≤1 can act and bets matched), else advance / close the round.
  function resolve (actorIdx) {
    if (complete) return
    if (activeSeats().length === 1) { complete = true; showdown = false; return }
    const ca = canActSeats()
    if (ca.length <= 1) {
      if (allMatched(ca)) { closeStreet() } else { toActIdx = nextCanAct(actorIdx) }
      return
    }
    if (allMatched(ca) && ca.every(s => acted.has(s))) { closeStreet(); return }
    toActIdx = nextCanAct(actorIdx)
  }

  for (let i = 0; i < actions.length; i++) {
    if (complete) return bad('ACTION_AFTER_COMPLETE', i)
    const act = actions[i]
    if (!act || act.seat !== seats[toActIdx]) return bad('OUT_OF_TURN', { i, expected: seats[toActIdx], got: act && act.seat })
    if (folded.has(act.seat) || allIn.has(act.seat)) return bad('CANNOT_ACT', act.seat)
    const seat = act.seat
    const owe = currentBet - street[seat]

    switch (act.type) {
      case 'fold':
        folded.add(seat)
        break
      case 'check':
        if (owe !== 0) return bad('CANNOT_CHECK_FACING_BET', i)
        acted.add(seat)
        break
      case 'call': {
        if (owe <= 0) return bad('NOTHING_TO_CALL', i)
        put(seat, owe)
        acted.add(seat)
        break
      }
      case 'bet':
      case 'raise': {
        const to = act.amount
        if (!Number.isInteger(to)) return bad('BAD_AMOUNT', i)
        if (act.type === 'bet' && currentBet !== 0) return bad('BET_WHEN_FACING_BET', i)
        if (act.type === 'raise' && currentBet === 0) return bad('RAISE_WITH_NO_BET', i)
        if (to <= currentBet) return bad('RAISE_NOT_HIGHER', i)
        const need = to - street[seat]
        if (need > stack[seat]) return bad('EXCEEDS_STACK', i)
        const raiseBy = to - currentBet
        const allInNow = need >= stack[seat]
        if (raiseBy < minRaise && !allInNow) return bad('BELOW_MIN_RAISE', { i, minRaise, raiseBy })
        put(seat, need)
        minRaise = Math.max(minRaise, raiseBy)
        currentBet = street[seat]
        acted = new Set([seat]) // re-opens action for everyone else
        break
      }
      case 'allin': {
        if (stack[seat] === 0) return bad('NOTHING_TO_ALLIN', i)
        put(seat, stack[seat])
        if (street[seat] > currentBet) {
          minRaise = Math.max(minRaise, street[seat] - currentBet)
          currentBet = street[seat]
          acted = new Set([seat])
        } else {
          acted.add(seat)
        }
        break
      }
      default:
        return bad('UNKNOWN_ACTION', act.type)
    }
    resolve(toActIdx)
  }

  return {
    contributions: { ...total },
    folded: [...folded],
    complete,
    showdown,
    street: STREETS[streetIdx],
    illegal: null
  }
}
