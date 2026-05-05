# Tutorial: Build an Atomic Blind Custody Handoff in 10 Minutes

A walkthrough for app developers using `p2p-hiverelay-client` to ship
an encrypted file handoff with cryptographic quorum receipts and a
network-enforced TTL.

By the end of this tutorial you'll have:

- An encrypted file handed off to 3 relay peers.
- Cryptographic receipts proving each relay anchored the exact ciphertext.
- A signed commit + source-retired record proving the handoff is final.
- A TTL the network actually enforces — relays unseed at the deadline.
- Independent witness tombstones attesting to non-serving state.

Prerequisites: Node.js 20+, an existing HiveRelay you can hit (your
own, a federated peer, or `npx p2p-hiverelay testnet --nodes 3` for a
local one), and the relay's API key.

---

## 1. Install and connect

```bash
npm install p2p-hiverelay-client
```

```js
import { HiveRelayClient } from 'p2p-hiverelay-client'
import { createHash, randomBytes } from 'crypto'
import sodium from 'sodium-universal'

const client = new HiveRelayClient('./client-storage')
await client.start()

const relayUrl = 'http://127.0.0.1:9100'  // your relay
const apiKey = process.env.HIVERELAY_API_KEY  // for write endpoints
```

## 2. Encrypt your payload

The relay never sees plaintext. Encrypt before handing off.

```js
// Your data (replace with whatever you're sending)
const plaintext = Buffer.from('the secret message')

// Generate an encryption key (give this to the recipient out-of-band)
const dataKey = randomBytes(32)

// Encrypt with libsodium secretbox (or any AEAD you trust)
const nonce = randomBytes(sodium.crypto_secretbox_NONCEBYTES)
const ciphertext = Buffer.alloc(plaintext.length + sodium.crypto_secretbox_MACBYTES)
sodium.crypto_secretbox_easy(ciphertext, plaintext, nonce, dataKey)

// The ciphertextRoot binds the custody handoff to this exact encrypted blob
const ciphertextRoot = createHash('sha256').update(ciphertext).digest('hex')

// blindContentId hides the content identity in public registries
const blindContentId = createHash('sha256').update(`session-${Date.now()}`).digest('hex')
```

## 3. Publish a custody intent

This is the publisher's signed declaration:

> I want N replicas of this exact encrypted ciphertext, by deadline T,
> retained until R, with this privacy posture.

```js
const retainUntil = Date.now() + 24 * 60 * 60 * 1000  // 24 hours
const intent = await client.publishCustodyIntent(relayUrl, {
  blindContentId,
  ciphertextRoot,
  contentVersion: 1,
  requiredReplicas: 3,
  deadline: Date.now() + 60_000,  // receipts must arrive within 1 minute
  retainUntil,
  shardPolicy: 'all',
  privacyTier: 'p2p-only',
  metadataVisibility: 'redacted'
}, { apiKey })

console.log('Intent published:', intent.intentId)
```

The relay validates the intent (forbidden plaintext field check, schema
check, signature) and appends it to the registry log. Other relays see
it propagate through the registry's Hypercore replication.

## 4. Seed the encrypted ciphertext

The encrypted bytes need to live on the relay quorum. Use `seed()`
with `blind: true` and the `custodyIntentId` so the relay automatically
emits a custody receipt when it finishes anchoring.

```js
// Publish the encrypted bytes as a Hyperdrive
const drive = await client.publish([
  { path: '/sealed/blob.bin', content: ciphertext },
  { path: '/sealed/manifest.json', content: Buffer.from(JSON.stringify({
    version: 1,
    blindContentId,
    ciphertextRoot,
    nonce: nonce.toString('hex')
  }, null, 2)) }
])

const appKey = drive.key.toString('hex')

// Seed it with custody parameters — the relay auto-emits a receipt
await client.seed(appKey, {
  type: 'drive',
  privacyTier: 'p2p-only',
  blind: true,
  storageClass: 'temporary',
  availabilityClass: 'atomic-handoff',
  custodyIntentId: intent.intentId,
  blindContentId,
  ciphertextRoot,
  contentVersion: 1,
  retainUntil
})
```

If your network has 3+ relays joined and accepting, each will anchor
independently and emit its own signed receipt.

## 5. Wait for quorum

Poll until enough relays have signed receipts:

```js
let status
const startedAt = Date.now()
while (Date.now() - startedAt < 60_000) {
  status = await client.getCustodyStatus(relayUrl, intent.intentId)
  if (status.quorumReached) break
  await new Promise(r => setTimeout(r, 2000))
}

if (!status.quorumReached) {
  throw new Error(`Only ${status.receiptCount}/3 receipts before deadline`)
}

console.log('Quorum reached:', status.relayQuorum)
```

`status.relayQuorum` is the sorted list of relay pubkeys whose
receipts are valid. `status.receiptRoot` is the deterministic hash
your commit must match.

## 6. Sign the commit

Once quorum is reached, the publisher signs a commit:

```js
const commit = await client.publishCustodyCommit(relayUrl, intent.intentId, {
  // The relay re-derives receiptRoot + relayQuorum from indexed
  // receipts and rejects mismatches. So you don't have to pass them.
}, { apiKey })

console.log('Commit signed:', commit.signature)
```

## 7. Retire source authority

After commit, the publisher retires their authority key. From this
moment, clients refuse further state-change signatures from the
retired key.

```js
await client.publishSourceRetired(relayUrl, intent.intentId, {
  retiredAtVersion: 1,
  nextAuthority: null  // or a successor authority key
}, { apiKey })

console.log('Authority retired')
```

The handoff is now complete. The recipient can verify the chain at
any time by reading the registry log entries for `intent.intentId`.

## 8. Out-of-band: share the data key

The relay never sees `dataKey`. You need to deliver it to the recipient
through some other channel — a paired secure messaging app, a QR code,
a key-agreement protocol, threshold release, or whatever your app's
trust model dictates.

```js
// Pseudo-code — depends on your app's key-distribution policy
await yourApp.deliverDecryptionMaterial(recipient, {
  intentId: intent.intentId,
  appKey,
  dataKey: dataKey.toString('hex'),
  nonce: nonce.toString('hex')
})
```

## 9. Recipient verifies and decrypts

The recipient reads the registry to verify custody, then decrypts.

```js
import { HiveRelayClient } from 'p2p-hiverelay-client'
const recipient = new HiveRelayClient('./recipient-storage')
await recipient.start()

// Verify the custody chain
const status = await recipient.getCustodyStatus(relayUrl, intentId)
if (!status.quorumReached || !status.committed || !status.sourceRetired) {
  throw new Error('Incomplete custody handoff — refusing to decrypt')
}

// Verify each receipt's signature against its declared relay pubkey
// (the relay's REST endpoint already enforces this server-side; for
// belt-and-braces verification, fetch the raw entries and validate)

// Read the encrypted bytes
const drive = await recipient.open(appKey)
const ciphertext = await recipient.get(appKey, '/sealed/blob.bin')
const manifest = JSON.parse(await recipient.get(appKey, '/sealed/manifest.json'))

// Decrypt with the out-of-band data key + nonce
const decrypted = Buffer.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES)
sodium.crypto_secretbox_open_easy(
  decrypted, ciphertext,
  Buffer.from(manifest.nonce, 'hex'),
  Buffer.from(dataKey, 'hex')
)
console.log('Plaintext:', decrypted.toString())
```

## 10. Wait for expiry

After `retainUntil`, the relay's expiry monitor unseeds the entry and
emits a `custody-expired` event. The relay can then sign a
`custody-non-serving-proof`.

```js
// Verify the relay actually stopped serving
const finalStatus = await client.getCustodyStatus(relayUrl, intent.intentId)
console.log('Non-serving proofs:', finalStatus.nonServingProofCount)
```

For high-integrity expiry, request witness tombstones from independent
witnesses (separate operators):

```js
// You'd typically hit a different relay's API for this
await client.recordCustodyExpiryWitness(witnessRelayUrl, intent.intentId, {
  blindContentId,
  relayPubkey: '<custody-relay-pubkey>',
  nonServingProofHash: '<hash-of-relay-non-serving-proof>',
  catalogPresent: false,
  gatewayServing: false,
  activeSwarmObserved: false
}, { apiKey: witnessApiKey })
```

A 5-of-7 witness quorum with operator-diverse witnesses gives you
strong post-expiry attestation that the custody relays actually
stopped serving.

---

## What you've built

You now have a full handoff with cryptographic evidence at every
stage:

- The intent is signed by you.
- Each receipt is signed by a different relay over the exact
  ciphertext root.
- The commit's `receiptRoot` cryptographically binds to the
  receipt set.
- The source-retired entry signed by you ends future state authority.
- The expiry monitor unseeded the relay's copy at the deadline.
- The non-serving-proof attests to that.
- Witness tombstones independently confirm the relay's non-serving state.

A recipient or auditor can reconstruct this entire chain from the
registry log alone, at any time, without trusting any single relay or
the publisher's later word.

## Next steps

- **Read the [whitepaper](./ATOMIC-BLIND-CUSTODY.md)** for the full
  protocol spec, threat model, and security analysis.
- **Read the [components tour](./WHATS-IN-THE-RELAY.md)** for the
  relay-side architecture.
- **Subscribe to the dashboard `/ws` feed** to watch your custody
  pipeline state in real-time.
- **Run the simulation** (`scripts/simulate-blind-atomic-custody.js`)
  to see how parameter choices affect availability, ciphertext
  reconstruction risk, and post-expiry detection.
- **Study the E2E test**
  (`test/integration/blind-custody-e2e.test.js`) for the canonical
  end-to-end usage pattern.
