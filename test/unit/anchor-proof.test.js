import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { auditAnchors, fetchAnchorProof } from 'p2p-hiverelay-verifier'

// ─── Helpers ───────────────────────────────────────────────────

function genKeypair () {
  const pk = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const sk = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(pk, sk)
  return { pk, sk }
}

function buildProof ({ appKey, anchored, version, attestedAt, sk, pk }) {
  const tag = b4a.from('hiverelay-anchor-proof-v1')
  const keyBuf = b4a.from(appKey, 'hex')
  const versionBuf = b4a.alloc(8)
  new DataView(versionBuf.buffer, versionBuf.byteOffset).setBigUint64(0, BigInt(version), false)
  const tsBuf = b4a.alloc(8)
  new DataView(tsBuf.buffer, tsBuf.byteOffset).setBigUint64(0, BigInt(attestedAt), false)
  const flagBuf = b4a.from([anchored ? 1 : 0])
  const payload = b4a.concat([tag, keyBuf, versionBuf, tsBuf, flagBuf])
  const sig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, payload, sk)
  return {
    schemaVersion: 1,
    appKey,
    anchored,
    version,
    attestedAt,
    relayPubkey: b4a.toString(pk, 'hex'),
    signature: b4a.toString(sig, 'hex')
  }
}

function mockFetch (responses) {
  // url → response object
  return async (url) => {
    const r = responses[url]
    if (!r) return { ok: false, status: 404, text: async () => '' }
    if (r.networkError) throw new Error(r.networkError)
    return {
      ok: r.ok !== false,
      status: r.ok === false ? (r.status || 500) : 200,
      text: async () => JSON.stringify(r.body || {})
    }
  }
}

// ─── Tests ─────────────────────────────────────────────────────

const APP_KEY = b4a.toString(b4a.alloc(32, 0xab), 'hex')

test('fetchAnchorProof: returns verified=true for a properly-signed proof', async (t) => {
  const { pk, sk } = genKeypair()
  const proof = buildProof({ appKey: APP_KEY, anchored: true, version: 5, attestedAt: Date.now(), pk, sk })
  const fetch = mockFetch({
    ['https://relay.example/api/anchors/' + APP_KEY + '/proof']: { body: proof }
  })
  const v = await fetchAnchorProof('https://relay.example', APP_KEY, { fetch })
  t.is(v.ok, true, 'fetched ok')
  t.is(v.verified, true, 'signature verified')
  t.is(v.proof.anchored, true)
  t.is(v.proof.version, 5)
})

test('fetchAnchorProof: returns verified=false for a tampered signature', async (t) => {
  const { pk, sk } = genKeypair()
  const proof = buildProof({ appKey: APP_KEY, anchored: true, version: 5, attestedAt: Date.now(), pk, sk })
  // Tamper with the version after signing
  const tampered = { ...proof, version: 999 }
  const fetch = mockFetch({
    ['https://relay.example/api/anchors/' + APP_KEY + '/proof']: { body: tampered }
  })
  const v = await fetchAnchorProof('https://relay.example', APP_KEY, { fetch })
  t.is(v.ok, true)
  t.is(v.verified, false, 'tampered version → signature invalid')
})

test('fetchAnchorProof: returns ok=false for unreachable relay', async (t) => {
  const fetch = mockFetch({}) // empty responses → 404
  const v = await fetchAnchorProof('https://nope.example', APP_KEY, { fetch })
  t.is(v.ok, false)
})

test('auditAnchors: aggregates anchored / unanchored / unreachable / unverified', async (t) => {
  const { pk: pk1, sk: sk1 } = genKeypair()
  const { pk: pk2, sk: sk2 } = genKeypair()
  const { pk: pk3, sk: sk3 } = genKeypair()
  const now = Date.now()

  // Relay 1: signs anchored=true, valid signature
  const proof1 = buildProof({ appKey: APP_KEY, anchored: true, version: 10, attestedAt: now, pk: pk1, sk: sk1 })
  // Relay 2: signs anchored=false, valid
  const proof2 = buildProof({ appKey: APP_KEY, anchored: false, version: 0, attestedAt: now, pk: pk2, sk: sk2 })
  // Relay 3: signs anchored=true but signature is invalid (we'll tamper)
  const proof3 = { ...buildProof({ appKey: APP_KEY, anchored: true, version: 7, attestedAt: now, pk: pk3, sk: sk3 }), version: 999 }
  // Relay 4: unreachable

  const fetch = mockFetch({
    ['https://r1.example/api/anchors/' + APP_KEY + '/proof']: { body: proof1 },
    ['https://r2.example/api/anchors/' + APP_KEY + '/proof']: { body: proof2 },
    ['https://r3.example/api/anchors/' + APP_KEY + '/proof']: { body: proof3 }
    // r4 absent → 404
  })

  const report = await auditAnchors(APP_KEY, [
    'https://r1.example',
    'https://r2.example',
    'https://r3.example',
    'https://r4.example'
  ], { fetch })

  t.is(report.relayCount, 4)
  t.is(report.anchored.count, 1, 'r1 anchored & verified')
  t.is(report.unanchored.count, 1, 'r2 unanchored & verified')
  t.is(report.unverifiedSignatures.length, 1, 'r3 has bad signature')
  t.is(report.unreachable.length, 1, 'r4 unreachable')
})

test('auditAnchors: rejects bad inputs', async (t) => {
  try {
    await auditAnchors('not-hex', ['https://x.example'])
    t.fail('should throw')
  } catch (err) { t.ok(err.message.includes('64 hex chars')) }
  try {
    await auditAnchors(APP_KEY, [])
    t.fail('should throw')
  } catch (err) { t.ok(err.message.includes('at least one')) }
})
