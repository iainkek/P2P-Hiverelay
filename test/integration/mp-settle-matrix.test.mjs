// mp-settle-matrix.test.mjs — certifies the mp-table's heads-up showdown settlement against
// the canonical reducer (settleHand) across the FULL outcome matrix: single winner, uncalled
// bet (winner over- or under-bet), fold, tie, and tie-with-an-uncalled-bet. The mp-table's
// settle logic is replicated here exactly; any divergence from the reducer would break the
// cooperative==dispute guarantee. Run: node test/integration/mp-settle-matrix.test.mjs
import { settleHand } from '../../packages/services/builtin/poker/money/reducer.js'
import { evaluate7, compareRank } from '../../packages/services/builtin/poker/money/hand-eval.js'
const C = (r, s = 0) => r * 4 + s
let pass = 0; const A = (c, m) => { if (c) { pass++; console.log('  ok', m) } else { console.error('  x', m); process.exitCode = 1 } }
// the mp-table's settle (winners array + split + uncalled refund), replicated verbatim
function mpSettle (writers, contrib, foldedArr, reveals, board) {
  const folded = new Set(foldedArr); const live = writers.filter(w => !folded.has(w))
  let winners
  if (live.length <= 1) winners = [live[0]]
  else { const ranks = {}; for (const w of live) ranks[w] = evaluate7([...reveals[w], ...board]); let best = ranks[live[0]]; for (const w of live.slice(1)) if (compareRank(ranks[w], best) > 0) best = ranks[w]; winners = live.filter(w => compareRank(ranks[w], best) === 0) }
  const c = {}; for (const w of writers) c[w] = contrib[w] || 0; const win = {}; for (const w of writers) win[w] = 0
  if (live.length <= 1) win[winners[0]] = Object.values(c).reduce((a, b) => a + b, 0)
  else { const minLive = Math.min(...live.map(w => c[w])); const contested = minLive * live.length; const ws = [...winners].sort(); const base = Math.floor(contested / ws.length), rem = contested - base * ws.length; ws.forEach((w, i) => { win[w] += base + (i < rem ? 1 : 0) }); for (const w of live) win[w] += (c[w] - minLive) }
  const net = {}; for (const w of writers) net[w] = win[w] - c[w]; return net
}
const W = ['a', 'b']
const aceHi = [C(12, 0), C(12, 1)], deuce = [C(0, 0), C(1, 1)]
const reg = [C(7, 0), C(9, 1), C(3, 2), C(5, 3), C(10, 0)]      // ordinary board
const bw = [C(12, 0), C(11, 1), C(10, 2), C(9, 3), C(8, 0)]     // A K Q J 10 — playable by both
const lowA = [C(0, 1), C(1, 2)], lowB = [C(2, 3), C(3, 1)]       // neither improves broadway
const ref = (contrib, folded, board, reveals) => settleHand({ board, contributions: contrib, folded, reveals }, new Set(W)).net
const cases = [
  ['single winner, equal bets', { a: 50, b: 50 }, [], reg, { a: aceHi, b: deuce }],
  ['uncalled bet, the OVER-bettor wins', { a: 100, b: 50 }, [], reg, { a: aceHi, b: deuce }],
  ['uncalled bet, the SHORT all-in wins', { a: 100, b: 50 }, [], reg, { a: deuce, b: aceHi }],
  ['fold with dead money', { a: 60, b: 20 }, ['b'], reg, { a: aceHi }],
  ['TIE, equal bets', { a: 100, b: 100 }, [], bw, { a: lowA, b: lowB }],
  ['TIE with an uncalled bet', { a: 100, b: 50 }, [], bw, { a: lowA, b: lowB }]
]
for (const [label, contrib, folded, board, reveals] of cases) {
  const r = ref(contrib, folded, board, reveals), mp = mpSettle(W, contrib, folded, reveals, board)
  A(r.a === mp.a && r.b === mp.b && (mp.a + mp.b) === 0, label + ' → mp {a:' + mp.a + ',b:' + mp.b + '} == reducer {a:' + r.a + ',b:' + r.b + '}')
}
console.log('\n' + pass + '/6 — heads-up settlement matches the reducer across the full outcome matrix')
process.exitCode = pass === 6 ? 0 : 1
