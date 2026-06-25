// settle.cjs — settlement glue: turns the off-chain reducer's result into the
// on-chain escrow close (Phase 10/11 client side). Pure encoding helpers; no
// network. CJS so the hardhat/ethers toolchain can use it directly.
//
// The reducer yields NET balances (deltas, summing to 0). The escrow holds each
// seat's DEPOSIT (session bankroll) and pays FINAL balances on close:
//   finalBalance[seat] = deposit[seat] + net[seat]
// which conserves the pot because Σ net = 0 ⇒ Σ final = Σ deposit.

const { AbiCoder, keccak256 } = require('ethers')
const abi = AbiCoder.defaultAbiCoder()

function coopDigest (escrowId, payees, balances) {
  return keccak256(abi.encode(['bytes32', 'address[]', 'uint256[]'], [escrowId, payees, balances]))
}

function disputeDigest (escrowId, sessionHash, payees, balances, epoch) {
  return keccak256(abi.encode(['bytes32', 'bytes32', 'address[]', 'uint256[]', 'uint256'], [escrowId, sessionHash, payees, balances, epoch]))
}

/**
 * Convert reducer output + on-chain deposits into the (payees, balances) the
 * escrow's cooperativeClose/disputeClose expects.
 * @param {string[]} participants  seat ids in canonical (descriptor) order
 * @param {Record<string,string>} seatToAddress  seat id → settlement address
 * @param {Record<string,bigint|number|string>} deposits  seat id → escrowed amount
 * @param {Record<string,number>} net  reducer balances (net deltas, chips==base units)
 * @returns {{ payees: string[], balances: bigint[] }}
 */
function finalBalances (participants, seatToAddress, deposits, net) {
  const payees = []
  const balances = []
  for (const seat of participants) {
    const addr = seatToAddress[seat]
    if (!addr) throw new Error('settle: no address for seat ' + seat)
    const dep = BigInt(deposits[seat] ?? 0)
    const delta = BigInt(net[seat] ?? 0)
    const final = dep + delta
    if (final < 0n) throw new Error('settle: negative final balance for ' + seat + ' (bet exceeded bankroll)')
    payees.push(addr)
    balances.push(final)
  }
  const sumFinal = balances.reduce((a, b) => a + b, 0n)
  const sumDep = participants.reduce((a, s) => a + BigInt(deposits[s] ?? 0), 0n)
  if (sumFinal !== sumDep) throw new Error('settle: not conserved (Σfinal != Σdeposit)')
  return { payees, balances }
}

module.exports = { coopDigest, disputeDigest, finalBalances }
