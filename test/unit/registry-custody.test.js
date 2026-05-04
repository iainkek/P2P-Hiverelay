import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { SeedingRegistry } from 'p2p-hiverelay/core/registry/index.js'
import { hashHex } from 'p2p-hiverelay/core/custody-signing.js'

function keyPair () {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function registryFixture () {
  const registry = new SeedingRegistry(null, null)
  const blocks = []
  registry.localLog = {
    async append (block) {
      blocks.push(JSON.parse(b4a.toString(block)))
    }
  }
  return { registry, blocks }
}

test('SeedingRegistry: custody quorum commit and source retirement', async (t) => {
  const { registry, blocks } = registryFixture()
  const publisher = keyPair()
  const relayA = keyPair()
  const relayB = keyPair()
  const observer = keyPair()
  const now = Date.now()
  const blindContentId = hashHex('blind-content')
  const ciphertextRoot = hashHex('ciphertext-root')

  const intent = await registry.publishCustodyIntent({
    blindContentId,
    ciphertextRoot,
    contentVersion: 3,
    requiredReplicas: 2,
    deadline: now + 60_000,
    retainUntil: now + 120_000
  }, publisher)

  t.is(blocks.length, 1, 'intent appended')

  await registry.recordCustodyReceipt({
    intentId: intent.intentId,
    blindContentId,
    ciphertextRoot,
    contentVersion: 3,
    retainUntil: now + 120_000,
    shardIds: [0]
  }, relayA)

  try {
    await registry.publishCustodyCommit({ intentId: intent.intentId }, publisher)
    t.fail('commit before quorum should fail')
  } catch (err) {
    t.ok(err.message.includes('quorum not reached'), 'commit before quorum is rejected')
  }

  await registry.recordCustodyReceipt({
    intentId: intent.intentId,
    blindContentId,
    ciphertextRoot,
    contentVersion: 3,
    retainUntil: now + 120_000,
    shardIds: [1]
  }, relayB)

  const status = registry.getCustodyStatus(intent.intentId)
  t.is(status.receiptCount, 2, 'two receipts indexed')
  t.is(status.quorumReached, true, 'quorum reached')

  const commit = await registry.publishCustodyCommit({ intentId: intent.intentId }, publisher)
  t.ok(commit.signature, 'commit signed')

  const retired = await registry.publishSourceRetired({ intentId: intent.intentId }, publisher)
  t.ok(retired.signature, 'source retirement signed')

  const proof = await registry.recordCustodyProof({
    intentId: intent.intentId,
    relayPubkey: b4a.toString(relayA.publicKey, 'hex'),
    challengeNonce: hashHex('challenge'),
    shardIds: [0],
    blockIndices: [0],
    passed: true,
    latencyMs: 25
  }, observer)
  t.ok(proof.signature, 'custody proof signed')

  const finalStatus = registry.getCustodyStatus(intent.intentId)
  t.is(finalStatus.committed, true, 'status reports committed')
  t.is(finalStatus.sourceRetired, true, 'status reports source retired')
  t.is(finalStatus.proofCount, 1, 'proof indexed')
  t.is(finalStatus.passingProofs, 1, 'passing proof counted')
})

test('SeedingRegistry: custody commit becomes effective after out-of-order receipts arrive', async (t) => {
  const source = registryFixture().registry
  const target = registryFixture().registry
  const publisher = keyPair()
  const relayA = keyPair()
  const relayB = keyPair()
  const now = Date.now()
  const blindContentId = hashHex('out-of-order-blind')
  const ciphertextRoot = hashHex('out-of-order-ciphertext')

  const intent = await source.publishCustodyIntent({
    blindContentId,
    ciphertextRoot,
    contentVersion: 9,
    requiredReplicas: 2,
    deadline: now + 60_000,
    retainUntil: now + 120_000
  }, publisher)

  const receiptA = await source.recordCustodyReceipt({
    intentId: intent.intentId,
    blindContentId,
    ciphertextRoot,
    contentVersion: 9,
    retainUntil: now + 120_000
  }, relayA)

  const receiptB = await source.recordCustodyReceipt({
    intentId: intent.intentId,
    blindContentId,
    ciphertextRoot,
    contentVersion: 9,
    retainUntil: now + 120_000
  }, relayB)

  const commit = await source.publishCustodyCommit({ intentId: intent.intentId }, publisher)

  target._applyEntry(intent)
  target._applyEntry(commit)
  let status = target.getCustodyStatus(intent.intentId)
  t.is(status.committed, false, 'commit is indexed but not effective before receipts')
  t.ok(status.commitPendingReason, 'pending reason is exposed')

  target._applyEntry(receiptA)
  target._applyEntry(receiptB)
  status = target.getCustodyStatus(intent.intentId)
  t.is(status.quorumReached, true, 'quorum reached after receipts arrive')
  t.is(status.committed, true, 'previously indexed commit becomes effective')
})
