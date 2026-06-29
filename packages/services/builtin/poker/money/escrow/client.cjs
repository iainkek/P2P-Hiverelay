// client.cjs — escrow client: orchestrates the on-chain half of a player's
// session so a UI (or a Node script) never touches raw calldata. Wraps the
// PokerEscrow + USD₮ contracts behind a small, intention-revealing API:
//
//   deposit a bankroll  → read state  → co-sign the net  → withdraw the net
//
// ethers v6. `runner` is an ethers Signer (for writes/signing) or a Provider
// (read-only getState). The browser cashier mirrors these same calls over a
// CDN ethers build; this CJS module is the tested reference + Node client.

const { Contract, getBytes } = require('ethers')
const { coopDigest, disputeDigest, finalBalances } = require('./settle.cjs')
const ESCROW_ABI = require('./abi/PokerEscrow.json')

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)'
]

class EscrowClient {
  constructor ({ escrowAddress, tokenAddress, runner }) {
    if (!escrowAddress) throw new Error('EscrowClient: escrowAddress required')
    if (!runner) throw new Error('EscrowClient: runner (signer or provider) required')
    this.runner = runner
    this.escrow = new Contract(escrowAddress, ESCROW_ABI, runner)
    this.token = tokenAddress ? new Contract(tokenAddress, ERC20_ABI, runner) : null
  }

  escrowId () { return this.escrow.escrowId() }

  // USD₮ wallet balance + current allowance to the escrow (for the cashier).
  async tokenStatus (owner) {
    if (!this.token) throw new Error('EscrowClient: no token configured')
    const addr = await this.escrow.getAddress()
    const who = owner || await this.runner.getAddress()
    const [balance, allowance] = await Promise.all([
      this.token.balanceOf(who), this.token.allowance(who, addr)
    ])
    return { balance, allowance }
  }

  // Approve (only if the allowance is short) then deposit a bankroll.
  async deposit (amount) {
    if (!this.token) throw new Error('EscrowClient: no token configured')
    const addr = await this.escrow.getAddress()
    const me = await this.runner.getAddress()
    const allowance = await this.token.allowance(me, addr)
    if (allowance < amount) {
      const approveTx = await this.token.approve(addr, amount)
      await approveTx.wait()
    }
    const tx = await this.escrow.deposit(amount)
    return tx.wait()
  }

  // Aggregate on-chain state for a UI: pot, settled flag, and per-seat
  // deposited / withdrawable / membership.
  async getState (seats = []) {
    const [pot, settled, escrowId] = await Promise.all([
      this.escrow.pot(), this.escrow.settled(), this.escrow.escrowId()
    ])
    const perSeat = {}
    for (const s of seats) {
      const [deposited, withdrawable, isParticipant] = await Promise.all([
        this.escrow.deposited(s), this.escrow.withdrawable(s), this.escrow.isParticipant(s)
      ])
      perSeat[s] = { deposited, withdrawable, isParticipant }
    }
    return { pot, settled, escrowId, seats: perSeat }
  }

  // EIP-191 personal-sign over the cooperative-close digest for these final
  // balances — what each player contributes to a co-signed settlement.
  async signCooperativeClose (escrowId, payees, balances) {
    const digest = coopDigest(escrowId, payees, balances)
    return this.runner.signMessage(getBytes(digest))
  }

  async cooperativeClose (payees, balances, sigs) {
    const tx = await this.escrow.cooperativeClose(payees, balances, sigs)
    return tx.wait()
  }

  async disputeClose (sessionHash, epoch, payees, balances, committeeSigs) {
    const tx = await this.escrow.disputeClose(sessionHash, epoch, payees, balances, committeeSigs)
    return tx.wait()
  }

  // Pull this signer's settled net. No-op-safe: throws NOTHING/NOT_SETTLED on chain.
  async withdraw () {
    const tx = await this.escrow.withdraw()
    return tx.wait()
  }

  // Turn a reducer result + on-chain deposits into the (payees, balances) the
  // close functions expect (final = deposit + net, conserves the pot).
  static finalBalances (participants, seatToAddress, deposits, net) {
    return finalBalances(participants, seatToAddress, deposits, net)
  }
}

module.exports = { EscrowClient, ESCROW_ABI, ERC20_ABI, coopDigest, disputeDigest, finalBalances }
