# Phase 01 — testnet happy-path proof (ready-to-run)

`PokerEscrow.sol` is the reference escrow. This proves the cooperative-close
design **in code**. The actual on-chain broadcast is the **one step not executed
in planning** — it requires a funded testnet key + RPC and is an external action
(needs explicit go-ahead). Steps to complete it:

1. **Pick an L2 testnet** with USD₮ (or a mock ERC-20): e.g. Arbitrum Sepolia or
   Base Sepolia. Deploy a mock USD₮ if no canonical testnet USD₮.
2. **Deploy** `PokerEscrow` with `escrowId`, the mock token, 2 participant
   addresses, a 1-key committee (for the dispute test), threshold 1, and an
   `expiry` ~1h out.
3. **Fund**: each of the 2 participants `approve` + `deposit` (e.g. 100 USD₮ each).
4. **Cooperative close**: both participants sign
   `keccak256(abi.encode(escrowId, payees, balances))` for a 150/50 split;
   call `cooperativeClose(payees, balances, [sigA, sigB])`. Assert balances move
   and `Closed("cooperative")` fires.
5. **(Optional) dispute close**: have the committee key sign
   `keccak256(abi.encode(escrowId, sessionHash, payees, balances, epoch))` and
   call `disputeClose(...)` on a fresh escrow; assert payout + anti-replay.
6. **(Optional) exit**: deploy, deposit, fast-forward past `expiry`, call
   `unilateralExit`, assert deposits returned.

**Do it through WDK** (the real integration check): use `@tetherto/wdk-wallet-evm`
to sign + broadcast the deploy/approve/deposit/close txns from two WDK wallets.
This simultaneously verifies RESEARCH §5.1 — that `wdk-wallet-evm` can send
arbitrary contract-call calldata + value. If it can't, the EVM path uses WDK as
signer only + ethers/viem for encoding (note the finding either way).

**Evidence to capture:** deploy tx, two deposit txs, the cooperative-close tx,
and final on-chain balances → paste refs into `RESULT.md` here.

> Why this isn't auto-run in planning: broadcasting consumes a funded key and is
> an externally-visible action. Provide a funded testnet key + RPC (or say "go")
> and this becomes a ~30-min execution.
