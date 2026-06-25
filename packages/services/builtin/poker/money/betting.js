// betting.js — heads-up No-Limit Hold'em betting engine (money layer, Phase 09).
//
// Pure, deterministic. Validates a raw action stream and produces the
// { contributions, folded } a hand needs for the settlement reducer. It does
// NOT deal cards or evaluate hands (that's the mental-poker layer + reducer) —
// it is the legal-betting + pot-accounting authority.
//
// v1 is HEADS-UP (2 seats): button posts the small blind and acts first
// pre-flop; the big blind acts first post-flop and holds the pre-flop option.
// Multiway (3+) is the documented next step (turn order generalizes; side-pot
// SPLITTING already lives in reducer.js).
//
// Action stream: [{ seat, type, amount? }] in turn order. type ∈
//   'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin'
// For 'bet'/'raise', `amount` is the TOTAL committed THIS STREET after the
// action (the "raise-to" total). 'call'/'allin' carry no amount. Blinds posted
// automatically.
//
//   playHand(config, actions) → { contributions, folded, complete, showdown, street, illegal }

const STREETS = ['preflop', 'flop', 'turn', 'river']

function bad (reason, detail) {
  return { illegal: { reason, detail: detail ?? null }, contributions: null, folded: null }
}

export function playHand (config, actions) {
  if (!config || !Array.isArray(config.seats) || config.seats.length !== 2) return bad('ONLY_HEADS_UP')
  const { seats, stacks, blinds, button } = config
  if (!seats.includes(button)) return bad('BAD_BUTTON')
  if (!Array.isArray(actions)) return bad('BAD_ACTIONS')
  const sb = button
  const bb = seats.find(s => s !== button)
  if (!stacks || !(stacks[sb] > 0) || !(stacks[bb] > 0)) return bad('BAD_STACKS')
  if (!blinds || !(blinds.bb > 0) || !(blinds.sb > 0)) return bad('BAD_BLINDS')
  const other = (s) => (s === sb ? bb : sb)

  const stack = { [sb]: stacks[sb], [bb]: stacks[bb] }
  const total = { [sb]: 0, [bb]: 0 }
  const street = { [sb]: 0, [bb]: 0 }
  const folded = new Set()
  const allIn = new Set()
  const put = (seat, amt) => {
    const a = Math.min(amt, stack[seat])
    stack[seat] -= a; total[seat] += a; street[seat] += a
    if (stack[seat] === 0) allIn.add(seat)
    return a
  }

  put(sb, blinds.sb)
  put(bb, blinds.bb)
  let currentBet = Math.max(street[sb], street[bb])
  let minRaise = blinds.bb
  let streetIdx = 0
  let toAct = sb // pre-flop: button/SB first
  let bbOptionPending = true
  let acted = new Set() // acted this street since the last bet/raise
  let complete = false
  let showdown = false

  const liveCount = () => [sb, bb].filter(s => !folded.has(s) && !allIn.has(s)).length
  const matched = () => street[sb] === street[bb]

  function closeStreet () {
    if (streetIdx === STREETS.length - 1) { complete = true; showdown = folded.size === 0; return }
    streetIdx++
    street[sb] = 0; street[bb] = 0
    currentBet = 0; minRaise = blinds.bb
    acted = new Set()
    bbOptionPending = false
    toAct = bb // post-flop: BB/non-button first
  }

  // After any non-aggressive resolution, if no one can act further (all-in/
  // fold) and bets are matched, run remaining streets out to showdown.
  function maybeRunOut () {
    if (complete) return
    if (liveCount() <= 1 && matched() && !(streetIdx === 0 && bbOptionPending)) {
      complete = true
      showdown = folded.size === 0
    }
  }

  for (let i = 0; i < actions.length; i++) {
    if (complete) return bad('ACTION_AFTER_COMPLETE', i)
    const act = actions[i]
    if (!act || act.seat !== toAct) return bad('OUT_OF_TURN', { i, expected: toAct, got: act && act.seat })
    if (folded.has(act.seat) || allIn.has(act.seat)) return bad('CANNOT_ACT', act.seat)
    const owe = currentBet - street[act.seat]

    switch (act.type) {
      case 'fold': {
        folded.add(act.seat)
        complete = true; showdown = false
        break
      }
      case 'check': {
        if (owe !== 0) return bad('CANNOT_CHECK_FACING_BET', i)
        acted.add(act.seat)
        if (streetIdx === 0 && act.seat === bb && bbOptionPending) {
          bbOptionPending = false
          closeStreet()
        } else if (acted.has(other(act.seat))) {
          closeStreet()
        } else {
          toAct = other(act.seat)
        }
        break
      }
      case 'call': {
        if (owe <= 0) return bad('NOTHING_TO_CALL', i)
        put(act.seat, owe)
        acted.add(act.seat)
        if (streetIdx === 0 && act.seat === sb && bbOptionPending) toAct = bb // give BB its option
        else closeStreet()
        break
      }
      case 'bet':
      case 'raise': {
        const to = act.amount
        if (!Number.isInteger(to)) return bad('BAD_AMOUNT', i)
        if (act.type === 'bet' && currentBet !== 0) return bad('BET_WHEN_FACING_BET', i)
        if (act.type === 'raise' && currentBet === 0) return bad('RAISE_WITH_NO_BET', i)
        if (to <= currentBet) return bad('RAISE_NOT_HIGHER', i)
        const need = to - street[act.seat]
        if (need > stack[act.seat]) return bad('EXCEEDS_STACK', i)
        const raiseBy = to - currentBet
        const allInNow = need >= stack[act.seat]
        if (raiseBy < minRaise && !allInNow) return bad('BELOW_MIN_RAISE', { i, minRaise, raiseBy })
        put(act.seat, need)
        minRaise = Math.max(minRaise, raiseBy)
        currentBet = street[act.seat]
        bbOptionPending = false
        acted = new Set([act.seat])
        toAct = other(act.seat)
        break
      }
      case 'allin': {
        if (stack[act.seat] === 0) return bad('NOTHING_TO_ALLIN', i)
        put(act.seat, stack[act.seat])
        if (street[act.seat] > currentBet) {
          const raiseBy = street[act.seat] - currentBet
          minRaise = Math.max(minRaise, raiseBy)
          currentBet = street[act.seat]
          bbOptionPending = false
          acted = new Set([act.seat])
          toAct = other(act.seat)
        } else {
          acted.add(act.seat)
          if (matched() || liveCount() === 0) closeStreet()
          else toAct = other(act.seat)
        }
        break
      }
      default:
        return bad('UNKNOWN_ACTION', act.type)
    }
    maybeRunOut()
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
