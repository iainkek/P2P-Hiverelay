import test from 'brittle'
import { settlementStatus } from '../../packages/services/builtin/poker/money/timeout.js'

const reveal = (writer, ts) => ({ writer, ts, payload: { kind: 'reveal' } })

test('a seat that reveals in time is not overdue; the laggard is', (t) => {
  const r = settlementStatus({
    entries: [reveal('alice', 100)], // bob never reveals
    expectedFrom: ['alice', 'bob'],
    expectedKind: 'reveal',
    triggerTs: 0,
    graceMs: 300,
    now: 400 // past the 300 deadline
  })
  t.is(r.deadline, 300)
  t.is(r.expired, true)
  t.alike(r.overdue, ['bob'])
})

test('before the deadline, nobody is overdue (even if not yet revealed)', (t) => {
  const r = settlementStatus({
    entries: [],
    expectedFrom: ['alice', 'bob'],
    expectedKind: 'reveal',
    triggerTs: 0,
    graceMs: 300,
    now: 200
  })
  t.is(r.expired, false)
  t.alike(r.overdue, [])
})

test('an entry posted AFTER the deadline does not save the laggard', (t) => {
  const r = settlementStatus({
    entries: [reveal('alice', 350)], // alice revealed late (deadline 300)
    expectedFrom: ['alice', 'bob'],
    expectedKind: 'reveal',
    triggerTs: 0,
    graceMs: 300,
    now: 400
  })
  t.alike(r.overdue.sort(), ['alice', 'bob'])
})

test('wrong-kind entries do not satisfy the obligation', (t) => {
  const r = settlementStatus({
    entries: [{ writer: 'bob', ts: 100, payload: { kind: 'chat' } }],
    expectedFrom: ['bob'],
    expectedKind: 'reveal',
    triggerTs: 0,
    graceMs: 300,
    now: 400
  })
  t.alike(r.overdue, ['bob'])
})
