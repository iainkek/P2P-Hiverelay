// attest.cjs — HR-side verdict attestation (Phase 03). A relay in the escrow's
// committee turns a reduced session into an on-chain-verifiable attestation: a
// secp256k1 (ecrecover-compatible) signature over the disputeClose digest. A
// threshold m-of-n of these is the ORACLE that settles the grief path when a
// player won't cooperatively co-sign.
//
// Each relay holds a secp256k1 ATTESTOR key (separate from its ed25519 network
// identity — the EVM verifies via ecrecover). Derivation of that key from the
// relay seed is the operator's concern; here it is an input.
//
// Trust: every attestor independently runs reduce(signedLog) and signs the SAME
// (sessionHash, payees, balances, epoch). No attestor trusts another's claim —
// the contract just counts distinct committee signatures over the digest.

const { Wallet, getBytes } = require('ethers')
const { disputeDigest, finalBalances } = require('./settle.cjs')

/**
 * Produce one relay's attestation over a reduced session.
 * @param {object} args
 * @param {string} args.attestorKey   secp256k1 private key (hex) of this relay
 * @param {string} args.escrowId      bytes32 hex
 * @param {string[]} args.participants seat ids in descriptor order
 * @param {Record<string,string>} args.seatToAddress
 * @param {Record<string,bigint|number|string>} args.deposits
 * @param {{ sessionHash: string, balances: Record<string,number> }} args.reducerResult
 * @param {number} args.epoch
 * @returns {Promise<{ signer, sessionHash, payees, balances, epoch, sig }>}
 */
async function attest ({ attestorKey, escrowId, participants, seatToAddress, deposits, reducerResult, epoch }) {
  if (reducerResult.illegal) throw new Error('attest: refusing to attest an illegal session')
  const { payees, balances } = finalBalances(participants, seatToAddress, deposits, reducerResult.balances)
  const sessionHash = reducerResult.sessionHash.startsWith('0x') ? reducerResult.sessionHash : '0x' + reducerResult.sessionHash
  const digest = disputeDigest(escrowId, sessionHash, payees, balances, epoch)
  const wallet = new Wallet(attestorKey)
  const sig = await wallet.signMessage(getBytes(digest))
  return { signer: wallet.address, sessionHash, payees, balances, epoch, sig }
}

/**
 * Aggregate attestations into the signature array disputeClose expects: sorted
 * by signer address ascending (the contract requires strictly-increasing
 * recovered signers to prevent double-counting). All inputs must agree on
 * (sessionHash, payees, balances, epoch).
 * @param {object[]} attestations
 * @returns {string[]} sorted sigs
 */
function aggregate (attestations) {
  if (attestations.length === 0) throw new Error('aggregate: no attestations')
  const ref = attestations[0]
  for (const a of attestations) {
    if (a.sessionHash !== ref.sessionHash || a.epoch !== ref.epoch) throw new Error('aggregate: divergent attestations')
  }
  return [...attestations]
    .sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1))
    .map(a => a.sig)
}

module.exports = { attest, aggregate }
