import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import {
  computeReceiptRoot,
  createCustodyCommit,
  createCustodyIntent,
  createCustodyProof,
  createCustodyReceipt,
  createSourceRetired,
  hashHex,
  verifyCustodyEntry
} from 'p2p-hiverelay/core/custody-signing.js'

function keyPair () {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

test('custody signing: intent/receipt/commit/retirement/proof verify', (t) => {
  const publisher = keyPair()
  const relay = keyPair()
  const observer = keyPair()
  const now = Date.now()
  const blindContentId = hashHex('blind-content')
  const ciphertextRoot = hashHex('ciphertext-root')

  const intent = createCustodyIntent({
    blindContentId,
    ciphertextRoot,
    contentVersion: 7,
    requiredReplicas: 1,
    deadline: now + 60_000,
    retainUntil: now + 120_000
  }, publisher, { timestamp: now })

  t.ok(verifyCustodyEntry(intent, { now }).valid, 'intent verifies')

  const receipt = createCustodyReceipt({
    intentId: intent.intentId,
    blindContentId,
    ciphertextRoot,
    contentVersion: 7,
    retainUntil: now + 120_000,
    relayRegion: 'test',
    shardIds: [0]
  }, relay, { timestamp: now + 1000 })

  t.ok(verifyCustodyEntry(receipt, { now: now + 1000 }).valid, 'receipt verifies')

  const commit = createCustodyCommit({
    intentId: intent.intentId,
    blindContentId,
    ciphertextRoot,
    contentVersion: 7,
    relayQuorum: [b4a.toString(relay.publicKey, 'hex')],
    receiptRoot: computeReceiptRoot([receipt])
  }, publisher, { timestamp: now + 2000 })

  t.ok(verifyCustodyEntry(commit, { now: now + 2000 }).valid, 'commit verifies')

  const retired = createSourceRetired({
    intentId: intent.intentId,
    blindContentId,
    retiredAtVersion: 7
  }, publisher, { timestamp: now + 3000 })

  t.ok(verifyCustodyEntry(retired, { now: now + 3000 }).valid, 'source retirement verifies')

  const proof = createCustodyProof({
    intentId: intent.intentId,
    blindContentId,
    relayPubkey: b4a.toString(relay.publicKey, 'hex'),
    challengeNonce: hashHex('challenge'),
    shardIds: [0],
    blockIndices: [1, 2],
    passed: true,
    latencyMs: 42
  }, observer, { timestamp: now + 4000 })

  t.ok(verifyCustodyEntry(proof, { now: now + 4000 }).valid, 'custody proof verifies')
})

test('custody signing: tampering and forbidden plaintext metadata are rejected', (t) => {
  const publisher = keyPair()
  const now = Date.now()
  const intent = createCustodyIntent({
    blindContentId: hashHex('blind-content'),
    ciphertextRoot: hashHex('ciphertext-root'),
    contentVersion: 1,
    requiredReplicas: 1,
    deadline: now + 60_000,
    retainUntil: now + 120_000
  }, publisher, { timestamp: now })

  const tampered = { ...intent, ciphertextRoot: hashHex('other-root') }
  t.is(verifyCustodyEntry(tampered, { now }).valid, false, 'tampered intent signature rejected')

  t.exception(() => createCustodyIntent({
    blindContentId: hashHex('blind-content'),
    ciphertextRoot: hashHex('ciphertext-root'),
    contentVersion: 1,
    requiredReplicas: 1,
    deadline: now + 60_000,
    retainUntil: now + 120_000,
    dataKey: 'never-send-this'
  }, publisher, { timestamp: now }), /forbidden/, 'dataKey is rejected')

  t.exception(() => createCustodyIntent({
    blindContentId: hashHex('blind-content'),
    ciphertextRoot: hashHex('ciphertext-root'),
    contentVersion: 1,
    requiredReplicas: 1,
    deadline: now + 60_000,
    retainUntil: now + 120_000,
    name: 'private docs'
  }, publisher, { timestamp: now }), /forbidden/, 'plaintext metadata is rejected')

  t.exception(() => createCustodyIntent({
    blindContentId: hashHex('blind-content'),
    ciphertextRoot: hashHex('ciphertext-root'),
    contentVersion: 1,
    requiredReplicas: 1,
    deadline: now + 60_000,
    retainUntil: now + 120_000,
    surpriseField: true
  }, publisher, { timestamp: now }), /unknown custody field/, 'unknown fields are rejected')
})
