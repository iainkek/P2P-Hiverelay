import test from 'brittle'
import sodium from 'sodium-universal'
import b4a from 'b4a'
import * as DK from '../../packages/services/builtin/poker/crypto/elgamal-deck.js'
import { nextDealAction, readMyHand } from '../../packages/services/builtin/poker/crypto/mp-deal-driver.js'

const rs = () => { const k = b4a.alloc(32); sodium.crypto_core_ed25519_scalar_random(k); return new Uint8Array(k) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// readMyHand is called on every wait tick of the table's runSeat loop — including
// before the deck/shuffles exist. It must degrade gracefully, never throw on a null
// deck (the bug that deadlocked the two-browser deal).
test('readMyHand degrades gracefully on an empty/early log', (t) => {
  const seat = { writer: 'a'.repeat(64), x: rs() }
  const seats = [seat.writer, 'b'.repeat(64)]
  const validPub = b4a.toString(b4a.from(DK.seatPub(rs())), 'hex')
  t.execution(() => readMyHand([], seat, seats), 'no throw on empty log')
  t.is(readMyHand([], seat, seats).ready, false, 'not ready on empty log')
  t.is(readMyHand([{ writer: seat.writer, payload: { kind: 'mp-key', pub: validPub } }], seat, seats).ready, false, 'not ready mid-handshake (only one key)')
  t.execution(() => readMyHand([{ writer: seat.writer, payload: { kind: 'mp-key', pub: 'garbage' } }], seat, seats), 'no throw on a malformed key entry')
})

// Two independent seats, each running the table's runSeat coordination over a shared
// mock relay (per-writer seq + read lag), must converge to a complete private deal.
test('two seats drive a full deal over a shared log (runSeat coordination)', async (t) => {
  function mockRelay () {
    const log = []; const lastSeq = new Map()
    return {
      async readLog () { await sleep(1); return { status: 200, json: { entries: log.map((e) => ({ writer: e.writer, payload: e.payload })) } } },
      async postMove (tk, e) { await sleep(1); const exp = (lastSeq.get(e.writer) ?? -1) + 1; if (e.seq !== exp) return { status: 409, json: { ok: false, reason: 'bad-seq' } }; lastSeq.set(e.writer, e.seq); log.push({ writer: e.writer, payload: e.payload }); return { status: 200, json: { ok: true } } }
    }
  }
  async function runSeat (rt, me, writers) {
    const seen = new Map(); const localLog = []
    const key = (e) => e.writer + '|' + e.payload.kind + '|' + (e.payload.pos ?? '')
    const ingest = (e) => { const k = key(e); if (!seen.has(k)) { seen.set(k, true); localLog.push({ writer: e.writer, payload: e.payload }) } }
    for (let g = 0; g < 4000; g++) {
      for (const e of (await rt.readLog()).json.entries) ingest(e)
      const action = nextDealAction(localLog, { writer: me.writer, x: me.x }, writers, me.mem)
      if (action) { const r = await rt.postMove('tk', { writer: me.writer, seq: me.seq, payload: action }); if (r.json.ok) { me.seq++; ingest({ writer: me.writer, payload: action }) } else await sleep(2); continue }
      const h = readMyHand(localLog, { writer: me.writer, x: me.x }, writers); if (h.ready) return h
      await sleep(3)
    }
    return { error: 'timeout' }
  }
  const A = { writer: '11' + b4a.toString(b4a.from(DK.seatPub(rs())), 'hex').slice(2), x: rs(), mem: {}, seq: 0 }
  const B = { writer: '22' + b4a.toString(b4a.from(DK.seatPub(rs())), 'hex').slice(2), x: rs(), mem: {}, seq: 0 }
  const writers = [A.writer, B.writer], rt = mockRelay()
  const [ha, hb] = await Promise.all([runSeat(rt, A, writers), runSeat(rt, B, writers)])
  t.absent(ha.error, 'seat A completed'); t.absent(hb.error, 'seat B completed')
  t.is(ha.hole.length, 2, 'A has 2 hole cards'); t.is(hb.hole.length, 2, 'B has 2 hole cards')
  t.alike(ha.board, hb.board, 'both agree on the board')
  t.is(new Set([...ha.hole, ...hb.hole, ...ha.board]).size, 9, '9 distinct cards')
  t.unlike(ha.hole, hb.hole, 'different hole cards per seat')
})
