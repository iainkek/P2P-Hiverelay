// Unit tests for the M1 binding-witness primitive.
//
// The binding-witness layer extends the atomic-blind-custody protocol so
// that double-issuance becomes algebraically detectable:
//
//   - Publisher emits `source-retired-witness` containing kPub, where kPub
//     is the Ed25519 public key deterministically derived from K via
//     blake2b(K || "drop-binding-v1").
//   - Recipient, after recombining K, derives the SAME (kPriv, kPub) and
//     signs a canonical claim-payload with kPriv. They publish a
//     `custody-claim-witness` containing the binding signature, signed
//     (separately, outer signature) by their own recipient keypair.
//   - Anyone with the published source-retired-witness can verify a
//     claim-witness's bindingSignature against kPub. Two claim-witnesses
//     with different recipientPubkeys both verifying = double-issuance.

import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import {
  createSourceRetiredWitness,
  createCustodyClaimWitness,
  canonicalClaimBindingPayload,
  verifyCustodyEntry,
  verifyClaimBinding,
  findCustodyConflict
} from '../../packages/core/core/custody-signing.js'

function newKeyPair () {
  const pk = b4a.alloc(32)
  const sk = b4a.alloc(64)
  sodium.crypto_sign_keypair(pk, sk)
  return { publicKey: pk, secretKey: sk }
}

function randomK () {
  const K = b4a.alloc(32)
  sodium.randombytes_buf(K)
  return K
}

function deriveKBindingKeypair (K) {
  const seed = b4a.alloc(32)
  sodium.crypto_generichash(seed, b4a.concat([K, b4a.from('drop-binding-v1')]))
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(64)
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  return { publicKey, secretKey }
}

function randomIntentId () {
  const buf = b4a.alloc(32)
  sodium.randombytes_buf(buf)
  return b4a.toString(buf, 'hex')
}

function signClaim (kKp, { intentId, recipientPubkey, timestamp }) {
  const payload = canonicalClaimBindingPayload({ intentId, recipientPubkey, timestamp })
  const sig = b4a.alloc(64)
  sodium.crypto_sign_detached(sig, payload, kKp.secretKey)
  return b4a.toString(sig, 'hex')
}

test('M1: source-retired-witness is signed by publisher and verifies', (t) => {
  const publisherKp = newKeyPair()
  const K = randomK()
  const kKp = deriveKBindingKeypair(K)
  const intentId = randomIntentId()

  const srw = createSourceRetiredWitness(
    { intentId, kPub: b4a.toString(kKp.publicKey, 'hex') },
    publisherKp
  )

  t.is(srw.type, 'source-retired-witness')
  t.is(srw.intentId, intentId)
  t.is(srw.kPub, b4a.toString(kKp.publicKey, 'hex').toLowerCase())
  t.is(srw.publisherPubkey, b4a.toString(publisherKp.publicKey, 'hex'))
  t.ok(/^[0-9a-f]{128}$/.test(srw.signature), 'has 128-hex outer signature')

  const v = verifyCustodyEntry(srw)
  t.ok(v.valid, 'outer signature verifies')
})

test('M1: custody-claim-witness is signed by recipient and verifies', (t) => {
  const publisherKp = newKeyPair()
  const recipientKp = newKeyPair()
  const K = randomK()
  const kKp = deriveKBindingKeypair(K)
  const intentId = randomIntentId()
  const recipientPubkey = b4a.toString(recipientKp.publicKey, 'hex')
  const timestamp = Date.now()

  const bindingSignature = signClaim(kKp, { intentId, recipientPubkey, timestamp })
  const ccw = createCustodyClaimWitness(
    { intentId, bindingSignature, timestamp },
    recipientKp,
    { timestamp }
  )

  t.is(ccw.type, 'custody-claim-witness')
  t.is(ccw.intentId, intentId)
  t.is(ccw.recipientPubkey, recipientPubkey)
  t.is(ccw.bindingSignature, bindingSignature)
  t.ok(/^[0-9a-f]{128}$/.test(ccw.signature), 'has 128-hex outer signature')

  const v = verifyCustodyEntry(ccw)
  t.ok(v.valid, 'outer signature verifies')

  const innerOk = verifyClaimBinding(ccw, b4a.toString(kKp.publicKey, 'hex'))
  t.ok(innerOk, 'inner binding signature verifies under kPub')
})

test('M1: tampered binding signature is rejected', (t) => {
  const publisherKp = newKeyPair()
  const recipientKp = newKeyPair()
  const K = randomK()
  const kKp = deriveKBindingKeypair(K)
  const intentId = randomIntentId()
  const recipientPubkey = b4a.toString(recipientKp.publicKey, 'hex')
  const timestamp = Date.now()

  const goodSig = signClaim(kKp, { intentId, recipientPubkey, timestamp })
  const badSig = '00' + goodSig.slice(2)
  const ccw = createCustodyClaimWitness(
    { intentId, bindingSignature: badSig, timestamp },
    recipientKp,
    { timestamp }
  )

  // Outer signature is still valid (recipient signed the entry).
  t.ok(verifyCustodyEntry(ccw).valid, 'outer signature still valid')

  // Inner binding signature must fail against the publisher-committed kPub.
  const innerOk = verifyClaimBinding(ccw, b4a.toString(kKp.publicKey, 'hex'))
  t.absent(innerOk, 'tampered binding signature is rejected')
})

test('M1: K-derivation is deterministic — same K → same kPub on both sides', (t) => {
  const K = randomK()
  const kp1 = deriveKBindingKeypair(K)
  const kp2 = deriveKBindingKeypair(K)
  t.alike(kp1.publicKey, kp2.publicKey, 'same K produces same kPub')
  t.alike(kp1.secretKey, kp2.secretKey, 'same K produces same kPriv')
})

test('M1: different K → different kPub (overwhelmingly likely)', (t) => {
  const kp1 = deriveKBindingKeypair(randomK())
  const kp2 = deriveKBindingKeypair(randomK())
  t.not(b4a.toString(kp1.publicKey, 'hex'), b4a.toString(kp2.publicKey, 'hex'), 'different K → different kPub')
})

test('M1: findCustodyConflict returns null when only one recipient claimed', (t) => {
  const publisherKp = newKeyPair()
  const recipientKp = newKeyPair()
  const K = randomK()
  const kKp = deriveKBindingKeypair(K)
  const intentId = randomIntentId()
  const recipientPubkey = b4a.toString(recipientKp.publicKey, 'hex')
  const timestamp = Date.now()

  const srw = createSourceRetiredWitness({ intentId, kPub: b4a.toString(kKp.publicKey, 'hex') }, publisherKp)
  const ccw = createCustodyClaimWitness({
    intentId,
    bindingSignature: signClaim(kKp, { intentId, recipientPubkey, timestamp }),
    timestamp
  }, recipientKp, { timestamp })

  const conflict = findCustodyConflict(srw, [ccw])
  t.is(conflict, null, 'no conflict with single claim')
})

test('M1: findCustodyConflict detects double-issuance — same K served to two recipients', (t) => {
  const publisherKp = newKeyPair()
  const aliceKp = newKeyPair()
  const malloryKp = newKeyPair()
  const K = randomK()
  const kKp = deriveKBindingKeypair(K)
  const intentId = randomIntentId()
  const ts = Date.now()

  const srw = createSourceRetiredWitness({ intentId, kPub: b4a.toString(kKp.publicKey, 'hex') }, publisherKp)

  // Alice claims legitimately.
  const alicePubkey = b4a.toString(aliceKp.publicKey, 'hex')
  const aliceClaim = createCustodyClaimWitness({
    intentId,
    bindingSignature: signClaim(kKp, { intentId, recipientPubkey: alicePubkey, timestamp: ts }),
    timestamp: ts
  }, aliceKp, { timestamp: ts })

  // Publisher then leaks K to Mallory, who also claims.
  const malloryPubkey = b4a.toString(malloryKp.publicKey, 'hex')
  const malloryClaim = createCustodyClaimWitness({
    intentId,
    bindingSignature: signClaim(kKp, { intentId, recipientPubkey: malloryPubkey, timestamp: ts + 1 }),
    timestamp: ts + 1
  }, malloryKp, { timestamp: ts + 1 })

  const conflict = findCustodyConflict(srw, [aliceClaim, malloryClaim])
  t.ok(conflict, 'conflict detected')
  t.ok(conflict.left.recipientPubkey !== conflict.right.recipientPubkey, 'pair has distinct recipients')
  t.ok(verifyClaimBinding(conflict.left, srw.kPub), 'left witness verifies under kPub')
  t.ok(verifyClaimBinding(conflict.right, srw.kPub), 'right witness verifies under kPub')
})

test('M1: claim-witness from someone WITHOUT K cannot forge a binding signature', (t) => {
  // Attacker (Mallory) does NOT have K but tries to claim a drop. She can't
  // produce a bindingSignature that verifies under the publisher's kPub.
  const publisherKp = newKeyPair()
  const aliceKp = newKeyPair()
  const malloryKp = newKeyPair()
  const K = randomK()
  const kKp = deriveKBindingKeypair(K)
  const intentId = randomIntentId()
  const ts = Date.now()

  const srw = createSourceRetiredWitness({ intentId, kPub: b4a.toString(kKp.publicKey, 'hex') }, publisherKp)

  // Mallory signs the claim payload with her OWN recipient keypair (not kPriv).
  const malloryPubkey = b4a.toString(malloryKp.publicKey, 'hex')
  const payload = canonicalClaimBindingPayload({ intentId, recipientPubkey: malloryPubkey, timestamp: ts })
  const wrongSig = b4a.alloc(64)
  sodium.crypto_sign_detached(wrongSig, payload, malloryKp.secretKey)

  const fakeClaim = createCustodyClaimWitness({
    intentId,
    bindingSignature: b4a.toString(wrongSig, 'hex'),
    timestamp: ts
  }, malloryKp, { timestamp: ts })

  // Outer signature is valid (Mallory signed her own entry), but the inner
  // binding signature does not verify under kPub — Mallory doesn't have K.
  t.ok(verifyCustodyEntry(fakeClaim).valid, 'outer signature passes (Mallory signed her own entry)')
  t.absent(verifyClaimBinding(fakeClaim, srw.kPub), 'forged binding fails — Mallory does not have K')

  // The conflict detector ignores invalid claims.
  const aliceClaim = createCustodyClaimWitness({
    intentId,
    bindingSignature: signClaim(kKp, { intentId, recipientPubkey: b4a.toString(aliceKp.publicKey, 'hex'), timestamp: ts }),
    timestamp: ts
  }, aliceKp, { timestamp: ts })

  const conflict = findCustodyConflict(srw, [aliceClaim, fakeClaim])
  t.is(conflict, null, 'no conflict — fake claim was filtered out')
})

test('M1: canonical claim payload is stable for fixed inputs', (t) => {
  const intentId = 'a'.repeat(64)
  const recipientPubkey = 'b'.repeat(64)
  const timestamp = 1700000000000

  const p1 = canonicalClaimBindingPayload({ intentId, recipientPubkey, timestamp })
  const p2 = canonicalClaimBindingPayload({ intentId, recipientPubkey, timestamp })
  t.alike(p1, p2, 'same inputs → same canonical payload')

  const p3 = canonicalClaimBindingPayload({ intentId, recipientPubkey, timestamp: timestamp + 1 })
  t.not(b4a.toString(p1), b4a.toString(p3), 'different timestamp → different payload')
})

test('M1: canonical claim payload rejects bad inputs', (t) => {
  t.exception(() => canonicalClaimBindingPayload({ intentId: 'short', recipientPubkey: 'b'.repeat(64), timestamp: 1 }), /intentId/)
  t.exception(() => canonicalClaimBindingPayload({ intentId: 'a'.repeat(64), recipientPubkey: 'short', timestamp: 1 }), /recipientPubkey/)
  t.exception(() => canonicalClaimBindingPayload({ intentId: 'a'.repeat(64), recipientPubkey: 'b'.repeat(64), timestamp: -1 }), /timestamp/)
})
