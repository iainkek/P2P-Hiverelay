import test from 'brittle'
import { playHand, createHand, applyAction, legalActions, view } from '../../packages/services/builtin/poker/money/betting.js'

// Drive an action stream through the interactive API and return a playHand-shaped result.
function drive (config, actions) {
  const S = createHand(config)
  if (S.illegal) return { illegal: S.illegal }
  for (const a of actions) { const r = applyAction(S, a); if (r && r.illegal) return { illegal: r.illegal } }
  const v = view(S)
  return { contributions: v.contributions, folded: v.folded, complete: v.complete, showdown: v.showdown }
}

test('interactive API is equivalent to playHand (heads-up)', (t) => {
  const cfg = { seats: ['a', 'b'], stacks: { a: 200, b: 200 }, blinds: { sb: 1, bb: 2 }, button: 'a' }
  const acts = [
    { seat: 'a', type: 'call' }, { seat: 'b', type: 'check' },
    { seat: 'b', type: 'check' }, { seat: 'a', type: 'check' },
    { seat: 'b', type: 'check' }, { seat: 'a', type: 'check' },
    { seat: 'b', type: 'check' }, { seat: 'a', type: 'check' }
  ]
  const ph = playHand(cfg, acts)
  const it = drive(cfg, acts)
  t.alike(it.contributions, ph.contributions)
  t.alike(it.folded, ph.folded)
  t.is(it.complete, ph.complete)
  t.is(it.showdown, ph.showdown)
  t.alike(ph.contributions, { a: 2, b: 2 })
})

test('interactive API is equivalent to playHand (3-handed, with a raise + fold)', (t) => {
  const cfg = { seats: ['a', 'b', 'c'], stacks: { a: 200, b: 200, c: 200 }, blinds: { sb: 1, bb: 2 }, button: 'a' }
  // a(button/UTG) raises to 8, b(SB) folds, c(BB) calls; then check it down.
  const acts = [
    { seat: 'a', type: 'raise', amount: 8 }, { seat: 'b', type: 'fold' }, { seat: 'c', type: 'call' },
    { seat: 'c', type: 'check' }, { seat: 'a', type: 'check' },
    { seat: 'c', type: 'check' }, { seat: 'a', type: 'check' },
    { seat: 'c', type: 'check' }, { seat: 'a', type: 'check' }
  ]
  const ph = playHand(cfg, acts)
  const it = drive(cfg, acts)
  t.is(ph.illegal, null)
  t.alike(it.contributions, ph.contributions)
  t.alike(it.folded.sort(), ph.folded.sort())
  t.is(it.complete, true)
  t.is(it.showdown, true)
  t.alike(ph.contributions, { a: 8, b: 1, c: 8 })
})

test('legalActions never offers an illegal move (drive a 4-handed hand by calling down)', (t) => {
  const cfg = { seats: ['a', 'b', 'c', 'd'], stacks: { a: 300, b: 300, c: 300, d: 300 }, blinds: { sb: 5, bb: 10 }, button: 'a' }
  const S = createHand(cfg)
  let guard = 0
  while (!S.complete && guard++ < 60) {
    const la = legalActions(S)
    t.ok(la && la.seat, 'a current actor exists while betting')
    // Always check if possible, else call — both must be legal per legalActions.
    const action = la.canCheck ? { seat: la.seat, type: 'check' } : { seat: la.seat, type: 'call' }
    const r = applyAction(S, action)
    t.is(r, null, 'a legalActions-derived move is accepted (' + action.type + ' by ' + la.seat + ')')
  }
  const v = view(S)
  t.is(v.complete, true, 'hand completed by calling down')
  t.is(v.showdown, true)
  // everyone called to the big blind → all contributed 10
  for (const s of ['a', 'b', 'c', 'd']) t.is(v.contributions[s], 10, s + ' called to 10')
})

test('createHand seats positions for a 6-max ring (UTG acts first pre-flop)', (t) => {
  const cfg = { seats: ['s0', 's1', 's2', 's3', 's4', 's5'], stacks: { s0: 1000, s1: 1000, s2: 1000, s3: 1000, s4: 1000, s5: 1000 }, blinds: { sb: 10, bb: 20 }, button: 's0' }
  const S = createHand(cfg)
  t.absent(S.illegal, 'valid 6-max config')
  const v = view(S)
  t.is(v.button, 's0', 'button is s0')
  t.is(v.toAct, 's3', 'UTG (button+3) acts first pre-flop')
  // SB=s1 posted 10, BB=s2 posted 20, pot = 30
  t.is(v.pot, 30)
  t.is(v.seats.find(x => x.seat === 's1').bet, 10, 'SB posted 10')
  t.is(v.seats.find(x => x.seat === 's2').bet, 20, 'BB posted 20')
  const la = legalActions(S)
  t.is(la.owe, 20, 'UTG owes the big blind')
  t.ok(la.canCall && la.canRaise && la.canFold && !la.canCheck, 'UTG can call/raise/fold, not check')
  t.is(la.minRaiseTo, 40, 'min raise-to is currentBet + minRaise (20 + 20)')
})

test('view exposes per-seat stacks/bets and a full ring drives to showdown (9-max)', (t) => {
  const seats = Array.from({ length: 9 }, (_, i) => 'p' + i)
  const stacks = {}; for (const s of seats) stacks[s] = 500
  const S = createHand({ seats, stacks, blinds: { sb: 5, bb: 10 }, button: 'p0' })
  t.absent(S.illegal, '9-max config is valid')
  let guard = 0
  while (!S.complete && guard++ < 120) {
    const la = legalActions(S)
    const r = applyAction(S, la.canCheck ? { seat: la.seat, type: 'check' } : { seat: la.seat, type: 'call' })
    t.is(r, null)
  }
  const v = view(S)
  t.is(v.complete, true)
  t.is(v.seats.length, 9, 'all 9 seats present in the view')
  t.is(v.pot, 90, 'nine seats each in for the big blind = 90')
})
