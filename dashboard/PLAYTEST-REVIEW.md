# P2Poker — playtest review (player's perspective)

A deep review of every user flow from the perspective of a real human sitting down
to play and to test the real-money rail on testnet. Living doc — updated as the
review loop runs.

## Trustless dealing — verifiable shuffle PROVEN browser-side (iteration 19)

The hard part of multiplayer poker is dealing without a trusted dealer on a
card-blind relay. The foundation already exists and is browser-pure: `hand-seed.js`
+ `vrf/ecvrf.js` (noble-based VRF) + `vrf/sortition.js`. Verified the full deal-seed
flow (7/7):

- Both seats derive the same `alpha` (`handSeedAlpha(tableKey, handId)`).
- Each seat VRF-`prove`s over alpha → 80-byte proof + 64-byte beta; `verifyHandSeed`
  confirms each under its pubkey; a proof under the **wrong** pubkey is rejected.
- `combineBetas` XOR-combines the betas → a seed **no single seat controls**;
  `handDeckOrder` turns it into a valid 52-card permutation, and XOR being
  order-independent means **both seats agree on the same deck**.

So the **verifiable, unbiasable shared shuffle is done and runs browser-side.** The
remaining piece is **mental-poker hole-card privacy** layered on this public deck
order — and its crypto primitive already exists and is **production-proven**:
`poker/crypto/chaum-pedersen.js` is threshold ElGamal decryption shares + Chaum-
Pedersen ZK proofs that each share is honest (cards encrypted to a joint key; to
reveal a card to one seat the others contribute proven shares without learning it).
The relay's **custody** system already uses it (PVSS-hinted seeds); its tests pass
(`custody-share-bundle` 14/14, `custody-claim-path-witness` 4/4), and the
prove/verify primitive checks out directly (honest share → `{valid:true}`, bad share
→ `{valid:false}`).

So mental poker is **not novel crypto to invent** — the primitive is built and
proven. The **browser point-op port is now done**: `poker/crypto/ed25519-noble.js`
implements the ed25519 group ops (base/point scalar-mult, add/sub, scalar add/mul,
validity) on noble, **byte-identical to sodium** — verified by fuzz (100/100
arithmetic matches; legitimate points valid; identity/small/mixed-order rejected,
i.e. ≥ as strict as sodium, matching chaum-pedersen's intent). So a hand
dealt/encrypted in the browser is decryptable + verifiable by the Node/relay sodium
code and vice-versa. What remains for mental poker: (a) a browser `chaum-pedersen`
that uses this backend (port prove/verify/share + match the Fiat-Shamir hash), (b)
the dealing **protocol** (encrypt deck to the joint key, deal hole cards via shares,
reveal at showdown), (c) serving noble to the browser (the recurring bundle step),
then the table UI.

### Multiplayer stack status
**"Share my address" link — the whole setup is now link-based (iter 63).** Cut the last
manual copy in the setup: the opponent sending the host their EVM address before the shared
deploy. Added a **"Share your address with the host →"** button (connects MetaMask, builds
`/cashier?opponent=<addr>`); the host opens it and the opponent field auto-fills + switches
to Live + prompts "Deploy your shared table." Verified (7/7): host link auto-fills the
opponent + Live + prompt; the joiner button is present, wired, and graceful with no wallet;
plain `/cashier` is unaffected; no errors. Now **every handoff in the two-human flow is a
shareable link** — share-address → escrow-link → game-join-link → one-click settle — with
no copy-pasting of addresses anywhere, which is what makes real human testing actually
happen instead of stalling on coordination.

**Shareable escrow link — cut the setup coordination (iter 62).** The biggest real barrier
to a tester completing a game is coordination, and one rough edge was the opponent having
to manually copy **two addresses** (escrow + token) to connect to a shared escrow. Mirrored
the mp-table's join link (iter 44): after a shared deploy, a **"Copy escrow link for your
opponent →"** button generates `/cashier?escrow=…&token=…`; opening that link auto-fills
both addresses, switches to Live, and prompts "Connect, faucet, deposit." Verified (8/8):
opponent link auto-fills escrow+token and switches to Live with a helpful prompt; the host
share button builds the correct link; plain `/cashier` doesn't auto-fill and the button
stays hidden until a shared escrow exists; no errors. One fewer manual copy-paste in the
real two-human setup.

**Nav health-check + the play screen was a dead-end (iter 61).** Health-checked all 11
nav-reachable pages (dashboard, payments, network, leaderboard, catalog, calculator,
cashier, lobby, mp-table, docs, table): **all load with no JS errors and render content** —
no broken pages anywhere. One real UX gap: the `/mp-table` (the main play screen) had its
"♠ P2Poker" brand as plain text and no nav, so from the table you could only reach the
Cashier via the buy-in note — a dead-end otherwise. Made the brand a home link → `/lobby`
and added a right-aligned **Cashier →** link to the header (the beforeunload guard still
protects a mid-session leave). Verified (5/5): both links present + correct, page still
initializes, no errors. (Noted but not changed: the relay-infra pages — Payments/Network/
Leaderboard — are HiveRelay-branded, slightly out of context for a poker tester, but
functional; the poker flow itself is coherent end to end.)

**Dispute-settlement recourse proven on-chain — but not yet enabled in the UI (iter 60).**
Found the disconnect that makes iter-56's "claim against a cheater" currently theoretical:
the cashier's `Deploy a test escrow` passes `committee=[], threshold=0`, so the escrow
reverts `disputeClose` with `DISPUTE_DISABLED`. The recourse mechanism is real in the
contract but turned off on every test escrow. Proved the full path works end-to-end on a
local EVM (8/8): an escrow deployed **with** a committee → the committee attests the
reducer's balances (B wins, A forfeits for cheating) → `disputeClose` → **B withdraws 1300
without A's cooperation**, A penalized to 700, escrow drained, conservation held; and a
**non-committee signature is rejected** (`NO_QUORUM`) so only the real committee can attest.
So `reduceMpHand` (iter 56) → committee sig → `disputeClose` → honest claim is now a proven
chain. The honest gap that remains is purely operational wiring: the cashier should deploy
test escrows with the relay's committee key, and the relay should expose an attest endpoint
that runs the reducer + threshold-signs. Test at `test/integration/dispute-close.test.cjs`.

**No-show / no-refund guidance at the deposit step (iter 59).** Reviewed the escrow's
refund semantics: `PokerEscrow.sol` is explicit that there is **no unilateral
deposit-refund** — funds come back only via `cooperativeClose` (all seats sign) or
`disputeClose` (committee). So the real "opponent never shows after I deposit" scenario
locks a tester's deposit until one of those paths runs. The top banner already states the
no-refund rule, but the actionable advice was missing at the moment of risk. Added a
prominent warning in the Deposit card: **"Deposit only once your opponent is also ready"** —
explaining the no-refund, how funds do come back, and that testnet USD₮ is faucetable so
it's low-stakes while testing. Verified (4/4): warning present, accurate, no errors. (A
real pre-game refund/timeout is a contract change with griefing subtleties — intentionally
left as a careful follow-up rather than an autonomous edit.)

**Real 2-player shared-escrow settlement verified through the UI (iter 58).** Iter 57
proved the *solo* cashier flow; the actual game settles on a **shared 2-player escrow**, so
I extended the harness to two mock wallets (hardhat accts 0/1) and drove the real
multiplayer money rail: A deploys a shared escrow naming B → both deposit 1000 (escrow
holds 2000) → both co-sign the *same* agreed split [1300,700] → A submits
`cooperativeClose([A,B],[1300,700],[sigA,sigB])` → both withdraw. On-chain end state: A
(winner) wallet 1300, B (loser) wallet 700, escrow fully drained — **conservation held**,
11/11, no page errors. This is the definitive "two humans settle real money on testnet"
verification. Harness at `test/integration/cashier-2p.test.cjs`.

**Cashier Live money rail verified end-to-end through the real UI (iter 57).** Until now
the escrow *contract* logic was proven on a local EVM, but the cashier's actual Live-mode
UI flow (buttons → ethers calls → contract interactions) was only read, not executed. Built
a mock EIP-1193 provider (`window.ethereum` backed by an ethers Wallet + a local hardhat
node reporting Base Sepolia's chainId 84532) and drove the **real cashier buttons** through
the whole money rail: Deploy a test escrow (USDT + escrow via `ContractFactory`) → faucet
mint → approve + `deposit(1000)` → EIP-191 sign → `cooperativeClose([me],[1000],[sig])` →
`withdraw()`. Verified on-chain at every step (wallet holds 1,000 after mint; escrow holds
the 1,000 deposit; escrow drains and the wallet ends whole) with **zero page errors** —
10/10. The one bug hit was in the *mock's* nonce handling (real MetaMask manages nonces);
the cashier itself was flawless. This is the strongest "works live on testnet" evidence
short of a real Base Sepolia deploy (gated). Harness preserved at
`test/integration/cashier-live.test.cjs`.

**Dispute-path reducer — claim against a cheater (iter 56).** The deepest open item:
until now an honest player could *refuse to co-sign* a cheat (denying the cheater), but
couldn't *claim* their winnings on-chain if the opponent stalled the cooperative close.
Built `packages/services/builtin/poker/mp-reducer.js` — the committee/dispute reference:
given the signed hand log it replay-verifies every shuffle (a cheat or withheld reveal
forfeits that seat), replays betting via the shared engine, opens the showdown from the
public decryption shares, and settles via `settleHand` — the same primitives the client
uses, so cooperative and dispute paths agree by construction. It outputs `balances =
buy-in ± net` for the escrow's `disputeClose`. Validated against real captured logs from
two-browser games: on honest play it **reproduces the client's net exactly** (host/joiner
20/−20, zero-sum, 5/5); on a cheating shuffle it **independently identifies the cheater
from the log alone** (`output-mismatch@0`), awards the honest seat, and agrees with the
honest player's own claim (5/5). The iter-50 standoff is resolved — an honest player can
now claim, not just deny. (Also confirmed the host/join handshake's 2-message exchange is
*inherent* to the security model — the guest must self-generate keys — not a fixable gap.)

**Mobile play reviewed + relay-unreachable feedback (iter 55).** Real testers use phones,
so I drove a full game on a 390×844 mobile viewport and screenshotted the in-hand UI: the
host handshake (numbered steps, a Copy button so no fiddly text-selection, disabled-until-
ready start) and the betting screen (both seats, pot, turn clock, full board, and
Fold/Call/Raise + slider) **all fit and are tappable** — mobile holds up. Separately,
traced a real robustness gap on any platform: if a bet post exhausts its 40 retries
(relay unreachable ~20s) it returned `false` and the loop silently re-prompted — the
player clicks Call, nothing visibly happens. Added explicit feedback (a log line + a
"relay unreachable — retry" turn pill) so a flaky network is legible, not mysterious.
Verified a full contested hand still completes (7/7), no regressions.

**Accidental-leave guard mid-session (iter 54).** A real edge a human will hit: refreshing
or closing the tab mid-session. The seat keys (Ed25519 sign keypair + ElGamal decryption
scalar, `makeSeat()`) live **only in memory** and the writer set is fixed at table
creation — so a reload can't rejoin a live session, stranding a player who's already
deposited. Added a `beforeunload` guard: while a session is in progress (`sessionActive`,
set/cleared via try-finally around `playSession`) an accidental refresh/close prompts a
confirmation; clicking **"Settle in the Cashier"** clears the flag first so the intended
exit never nags. Verified (7/7): no nag on the landing, warns mid-session for both seats,
quiet after choosing to settle, and a full hand still completes (the wrap didn't break
playSession). *Residual:* this prevents accidental loss but not recovery after a
confirmed-leave/crash — full seat-key persistence + resume is the larger follow-up.

**Player onboarding guide added to /docs (iter 53).** A tester clicking "Docs" got
HiveRelay *operator/SDK* docs (install a node, the Pear SDK, architecture) — no
player-facing "how to play" anywhere. Added a **"Playing Poker (testnet)"** guide at the
top of `/docs` (own sidebar section): the one-line loop, then 3 steps — get test USD₮ +
open a shared escrow (faucet → deposit the buy-in), host/join + play, settle + cash out —
plus a "what if they won't co-sign" note and a trust-model section (no custody, provably
fair deal, settlement integrity). Every button name matches the real UI exactly ("Get
1,000 test USD₮", "Create table & deal", "Settle in the Cashier", "Fill balances from my
multiplayer net") and it links to `/mp-table` + `/cashier`. Verified (8/8): section +
anchors render, wording matches the live buttons, no errors.

**Lobby rewired to the real multiplayer flow (iter 52).** The `/lobby` (the natural
"find a game" page) actively misled: the hero "Play now" went to the solo `/table`, the
create card said "live multiplayer **soon**" (it's live), and **every** "Sit down" —
including on real relay tables — routed to solo play. Fixed to be honest: hero CTA →
"Play a human →" `/mp-table`; the create card is "Host a heads-up table" → `/mp-table`;
real **live**-badged relay tables get a "Join →" to `/mp-table`, while demo tables are
explicitly "Practice (solo) →" `/table`; a section clarifier spells out live = real vs
others = solo practice. Verified (7/7): every CTA routes correctly, no stale "soon", no
page errors. Nothing in the lobby now misrepresents what's playable.

**Discoverability — the table was orphaned from navigation (iter 51).** A pure
player's-perspective pass (screenshotted every screen). The landing, host handshake, and
cashier all read clearly — but the main feature was unreachable: the shared top-nav
(Dashboard · Payments · Cashier · Lobby · Play · Network · Leaderboard · Docs) had **no
link to `/mp-table`**. "Play" points at the solo `/table`; a real tester would never find
the human-vs-human table without typing the URL. Added a **"Multiplayer"** nav entry →
`/mp-table` across all 10 nav-bearing pages. Verified (7/7): the link renders on
cashier/dashboard/lobby/table/leaderboard and the table loads from it, no errors. (No
amount of protocol correctness helps if players can't reach the table.)

**Actionable settle path from the table (iter 51).** The session-over message *told* you
to "settle in the Cashier" but wasn't clickable, and there was no way to stop & settle
between hands (you'd have to navigate away manually). Added a **"Settle in the Cashier →"**
button that appears after every completed hand (the net is bridged each hand) and on bust
— one click to the cashier, where the iter-47 one-click fill takes the bridged net. Closes
the loop: nav → table → play → one click → settle → withdraw. Verified (8/8): both seats
see the button between hands, it links to `/cashier`, net bridged.

**Shuffle cheat-evidence wired into showdown (iter 49).** Another protocol-invariant gap:
the table opened cards at showdown but never *verified the shuffles*. The re-encryption
shuffle is plaintext-preserving only if honest — a malicious client could post an invalid
shuffle that substitutes its hole card for a better one buried in the unopened deck (a
plain distinct-cards check wouldn't catch it). The `reencrypt-shuffle` commit-reveal
exists for exactly this but wasn't used. Now at showdown each seat **reveals its shuffle
params** (`perm`/`rands`, pre-committed at deal time) and **replay-verifies every seat's
shuffle**; an invalid shuffle (or a withheld reveal) forfeits the cheater. Verified:
`verifyShuffle` catches substituted cards / lying about params / non-permutations (4/4
isolation); honest two-browser play replay-verifies both shuffles with no false forfeit
and correct zero-sum settle (7/7); the disconnect-forfeit path stays intact (8/8).

**Cheat→forfeit proven end-to-end (iter 50).** Upgraded the by-composition coverage to a
live adversarial test: a deliberately-malicious browser (`window.__cheatShuffle` test
hook posts a tampered shuffle — two ciphertexts swapped, a card substitution — while
keeping the real `perm`/`rands`) plays a normal hand against an honest host. The honest
host reaches showdown, replay-verifies, and **catches it** (`output-mismatch@0`),
forfeits the cheater, and is awarded the pot (8/8: cheat detected, reason is a shuffle
cheat, host wins, took the forfeit path not the clean path, UI shows the win). The cheat
branch is no longer theoretical — a cheating shuffle is caught and auto-forfeited live.

**Uncalled-bet refund — cooperative == dispute settle (iter 48).** A deep-protocol bug
that carried stacks made reachable: with unequal stacks a seat can be all-in for *less*
than the opponent's bet, leaving an **uncalled bet**. The settle did winner-takes-
sum(contributions), which over-pays the winner *and disagrees with the reducer's
`settleHand`* (the dispute path) — so a player could get a better result one way than the
other (not trustless). Fixed with effective-pot accounting (contested pot capped at 2×
the smaller live contribution; the over-bettor's excess refunded). Verified the
cooperative settle now **equals** `settleHand` across scenarios incl. the uncalled case
(5/5): A over-bets, B all-in 50, B wins → `{a:-50,b:+50}` (A's 50 refunded), matching the
reducer exactly. Normal contested hand intact (13/13).

**One-click settle from the net (iter 47).** Co-signing the cooperative close required
both seats to manually enter the *same* balances — error-prone. Added a **"Fill balances
from my multiplayer net"** button to the cashier settle: it reads the bridged session net
+ each payee's on-chain deposit and computes `balance = deposit ± net`. Because the net
is zero-sum and deposits are on-chain facts, **both seats compute identical balances**, so
the co-signatures match. Verified (7/7): host (net +300) and joiner (net −300) both
produce [1300,700], summing to the deposits (conservation), button wired + graceful (no
net → clear message), no CSP/JS errors. The settle is now: paste both addresses → one
click → sign → submit.

**Money loop verified + buy-in made explicit (iter 46).** Confirmed the carried-stack
net settles **exactly** on-chain at the real scale (5/5 on a local EVM): both deposit the
buy-in (1000) → pot 2000 → a session net of +300 → `cooperativeClose` balances [1300,700]
(sum = deposits, conservation holds) → each withdraws its final stack → escrow drains to
0. This only reconciles if **1 chip = 1 USD₮ and deposit = buy-in**, so made that
explicit on `/mp-table`: a prominent "Buy-in: 1000 USD₮ (1 chip = 1 USD₮)" note telling
both seats to deposit 1000 into a shared escrow before playing and settle the net after.

**Carried stacks — a real correctness fix (iter 45).** Each hand used to reset to a
fixed 1000-chip stack with the net just accumulating, so across multiple hands a player
could lose **more than they deposited** — which the on-chain `cooperativeClose` can't
settle (conservation: payouts can't exceed deposits). Now stacks **carry across hands**
(start = buy-in, bounded ≥ 0 by all-in caps), the button rotates each hand, and a seat
that can't post the big blind busts → **session over** with the final net. The session
net is now `stack − buy-in ∈ [−deposit, +deposit]` — always on-chain-settleable. The
result line shows your running stack. Verified: 2-hand check/call session stays
zero-sum + bounded (7/7); an all-in win busts the opponent → session over, net ±1000 =
the deposit (8/8). (Also removed the now-dead fixed-stack `bettingConfig`.)

**Shareable join link (iter 44).** The host→joiner handshake was copy-paste a long code;
now the host gets a **join link** (`/mp-table?join=<invite>`) to share (chat/DM). Opening
it auto-opens the join flow with the invite pre-filled + accepted, so the opponent just
sends their join code back. Verified two-browser (4/4): host shows the link, the joiner
*opens the link* (no paste) → auto-accepts → produces its code → the deal completes. Much
smoother onboarding (the raw code is still available for manual paste).

**Showdown clarity + turn alert (iter 43).** Two playing-experience touches: the
showdown result now **names the winning hand** ("Opponent wins (40) with two pair") so
you see *why* you won/lost (real poker UX); and when it's your turn the **tab title**
changes to "▶ Your turn — P2Poker" so a player whose tab is backgrounded gets alerted
(reverts on action). Verified the hand-name banner two-browser (13/13, no regression).

**Mobile (iter 42).** The multiplayer table is phone-friendly: on a 390px viewport the
two seats stack vertically (You / Opponent), the board + betting controls + raise slider
fit with no horizontal overflow, cards render with correct colours. Verified 5/5
(landing + dealt table no overflow, both seats on-screen, 9 cards render, no JS errors)
— a tester can play `/mp-table` on their phone.

**Disconnect forfeit (iter 41) — the last robustness gap.** A full disconnect (browser
closed → no local timer) used to trap the opponent. Now when you're waiting on a seat
that's gone past the deadline (default 60s, anchored on the relay-bounded entry `ts`), a
**"claim the pot"** button appears; claiming posts a `forfeit` entry and the absent seat
is settled as folded → you take the pot. Verified two-browser (8/8): the joiner closes
its browser mid-hand → after the deadline the host sees the claim button → claims → wins
the 40 pot (net +20), no longer stuck. So an abandoning player can't trap your money —
the table is now production-shaped for unsupervised play.

**Turn clock (iter 40).** A 30s per-turn countdown (shown in the turn pill) so an AFK
player can't freeze the game: on expiry it auto-checks if the action is free, else
auto-folds. Verified two-browser (5/5): with the joiner never clicking, its clock
auto-checks each turn and the hand still completes, both agreeing on the result.
(Handles the AFK-but-connected case; a full disconnect — browser closed, no timer —
still needs an opponent-claimed timeout-forfeit using relay timestamps, which
`timeout.js` already models. Next.)

**Raise sizing (iter 39).** The Raise button only did a fixed min-raise; added a
**slider** spanning `[minRaiseTo … maxRaiseTo]` (all-in) in BB steps so a player chooses
their bet/raise amount, with a live amount label. Verified two-browser (8/8): host
drags to all-in (1000), label tracks, joiner calls → pot 2000, settles host +1000 /
joiner −1000 (zero-sum, |net| = pot/2). Betting is now real (not just min-raise).

**Multi-hand sessions + clean folds (iter 37–38).** `/mp-table` now plays a *session*,
not a single hand: after each hand the host clicks **"Deal next hand"** and a fresh
relay table is created (keys/identities reused — no re-handshake; the new key is
announced on the prior table's log for the joiner to pick up), with the session net
accumulating across hands and bridged to the Cashier for one settlement. Verified
two-browser over a 2-hand session (7/7): both play exactly 2 hands, the session net
evolves (host −20 then 0) and stays zero-sum. Also fixed folds (iter 37): an
uncontested win takes the pot with **no card reveal** (and survives the folder
disconnecting) — verified 10/10. Both showdown paths green (contested 13/13, fold 10/10).

**Shared 2-player escrow — the on-chain settle for two humans (iter 35).** The cashier's
self-serve deploy only made a *solo* escrow; added an optional **opponent-address** field
so a host deploys a shared escrow with both EVM addresses as participants (validated;
blank = solo). Verified the full two-player on-chain cycle on a local EVM (7/7): deploy
`[A,B]` → both deposit (pot 200) → `cooperativeClose` settles with **both signatures** →
both withdraw their net (A 1050, B 950) → escrow drains to 0 (conservation held). So two
humans can now share one escrow, deposit, and settle the session net on-chain — the
escrow side of the multiplayer money loop is complete. Cashier still loads clean (faucet
6/6, no CSP/JS errors). Remaining UX wire: carry the mp-table session net + opponent EVM
address straight into the cashier's settle (today it's entered manually).

**Hand net → settlement bridge (iter 34).** The showdown now computes each seat's
**net** (winnings − contributions — exactly what settles on-chain), accumulates a
session net across hands, shows it in the result banner ("…Net this hand +20 · session
+20"), and bridges it to `localStorage` (`p2poker.mp.net`) for the Cashier. Verified in
the two-browser hand (13/13): the two seats' nets are **zero-sum (+20 / −20)**, the
winner is positive, the session accumulates, and the bridge value matches. The only
remaining wire to settle a testnet pot for real is the on-chain `cooperativeClose`:
exchange EVM addresses in the handshake (so the net maps to escrow payees) and co-sign
the net — the escrow half (`cooperativeClose` + withdraw) is already proven on Base
Sepolia via the Cashier.

**A COMPLETE playable hand, two browsers — deal → bet → showdown → settle (iter 33).**
Added betting + showdown to `/mp-table`: after the trustless deal, both seats
reconstruct `betting.js` state from the relay's bet-action log and act on their turn
(Fold / Check-Call / Raise controls), then at showdown each publishes its own hole-card
shares so both hands open, the better hand is scored (`hand-eval`), and a result banner
shows the winner + pot. Verified with **two separate browsers** against a booted relay
(9/9): both reach showdown, agree on the board, the pot (40), and the winner; the UI
shows "Opponent wins (40)." — a real human-vs-human hand, dealt trustlessly, bet,
revealed, and settled, both agreeing on the outcome.

One real bug found + fixed: the log mirror's dedup key was `writer|kind|pos`, so a
seat's *second* bet-action (no `pos`) collided with its first and was dropped → betting
deadlocked. Betting now reconstructs from the relay's **ordered** log (turn order
matters) with a count-guard against double-posting during read lag. Remaining: wire the
hand's net into the Cashier's on-chain `cooperativeClose` (the escrow half is already
proven) so the testnet pot settles for real.

**TWO HUMANS, TWO BROWSERS — a real trustless deal over the relay (iter 32).** Added a
host/invite handshake to `/mp-table` (the relay fixes its writer allowlist at table
creation, so keys are exchanged first via a copy-paste code, WebRTC-style): host shows
an invite code, joiner returns a join code, host creates the table with both, then each
browser drives only its own seat with a `runSeat` loop (poll log → `nextDealAction` →
sign+postMove). Verified with **two separate browser instances** against a booted relay
(8/8): after exchanging codes, both complete a full mental-poker deal over the relay —
host holds e.g. 8♠9♣, joiner Q♣T♦, both agree on the board, 9 distinct cards, each sees
only its own hole cards. This is real human-vs-human trustless dealing.

Two genuine bugs surfaced + fixed (both would have broken live play):
- **deadlock:** `readMyHand` dereferenced a null deck on every wait tick (before the
  deck exists) → a waiting seat crashed → deadlock. Now degrades to `{ready:false}`.
- **rate-limit give-up:** `runSeat` hammered the relay (no throttle) → "Too many
  requests" → it treated the rejection as fatal and gave up. Now throttles (~250ms;
  poker isn't latency-critical) and backs off + retries any transient rejection.
Also hardened `dealStateFromLog`/`unhex` to skip a malformed key entry instead of
crashing the reader (the relay doesn't validate payload content). Locked in
`poker-mp-driver.test.js` (readMyHand-early + two-seat runSeat coordination); off-chain
suite **87/87**. Remaining: betting + showdown UI → on-chain settle.

**First working multiplayer table UI — live deal over the relay (iter 31).** Added
`/mp-table` (dashboard route) — a page that drives a **real mental-poker deal over the
real relay** and renders it: two seats exchange ElGamal keys, post an encrypted deck,
each re-encrypt-shuffles, publish decryption shares — every step a signed log entry —
then each opens its private hole cards while the board is public. Verified end-to-end
against a booted relay (9/9): page loads (crypto modules + noble import map resolve
under the relay CSP), a full deal completes over the relay (19 signed entries), both
seats render 2 private hole cards + 5 board cards, all 9 distinct, hole cards face-up
in the UI, zero CSP violations, zero errors. Screenshot confirms a clean felt with
correct card rendering. (Also fixed the `/poker-engine/crypto/` route path — it pointed
at `money/crypto/` but the modules are at `poker/crypto/`; only caught now because
iter-29 tested via a stand-in server, not the relay.) Remaining: host/invite handshake
so two separate browsers join one table (relay writers are fixed at creation) +
betting/showdown UI → on-chain settle.

**Deal driver built (iter 30).** `mp-deal-driver.js` is the deal-phase state machine
the table UI runs: `nextDealAction(log, seat, seats, mem)` returns the one payload a
seat should post next (key → deck → shuffle-in-order → shares for others' holes +
board) or null while waiting; `readMyHand` reads the seat's private cards once shares
are in. Pure + deterministic over the log, so both seats converge with no extra
coordination. Verified (7/7): two seats independently drive a full deal to quiescence
in 19 bounded moves, each reads 2 private hole cards, both agree on the board, 9
distinct cards, and the driver never leaks a seat's own hole cards. The UI loop is now
just: poll log → nextDealAction → sign+postMove → repeat.

**The whole engine now runs IN-BROWSER via the relay (iter 29).** Extended the
`/poker-engine/` route to serve the `crypto/**` subtree, made the browser crypto
modules Node-free (replaced `Buffer` hex with pure-JS in `elgamal-deck`,
`hand-deal-protocol`, `reencrypt-shuffle`), and verified a full 2-seat deal runs in a
real browser loading only relay-served `/poker-engine/crypto/*` + the noble import map
(6/6): both seats hold private hole cards, the board is public, 9 distinct cards,
**privacy holds in-browser**, zero load failures. So every layer — transport, crypto,
deal, settlement — is now browser-executable. The only remaining piece is the table
**UI** that drives it for two humans (a thin `relay-table-client.postMove` wrapper +
the screen). Suites green (off-chain 85/85, routes 5/5).

**A COMPLETE trustless hand is now built + in the test suite (iter 28).**
`poker-mental-multiplayer.test.js` plays a full 2-seat hand purely by replaying a
shared message log: deal (private hole cards, opponent can't see them) → betting
(`betting.js` actions over the log) → showdown (each seat reveals its own hole-card
shares) → `reduce()` → settlement. Verified + locked into the suite (off-chain now
**85/85**): both seats reconstruct identical state, the 9 cards are one verifiable
deck, the showdown matches what each privately held, and the settlement is zero-sum
and pays the better hand — exactly the net balances the escrow settles. The hard
protocol is done; what remains is the **table UI** + wrapping the log payloads in
`relay-table-client.postMove` (transport already proven). No crypto, no new protocol.

1. Relay table / shared signed log — ✅ proven (iter 16)
2. Browser signing + identity (`relay-table-client.js`) — ✅ built + proven (iter 18)
3. Verifiable shared shuffle (VRF deal-seed) — ✅ proven browser-side (iter 19)
4. Mental-poker hole-card privacy — ✅ **all crypto built + verified browser-side,
   relay-compatible**: primitive production-proven (iter 20), `ed25519-noble`
   byte-identical to sodium (21), `chaum-pedersen-browser` wire-compatible (22),
   `elgamal-deck` threshold encryption — a card opens only with every seat's proven
   share, one share reveals nothing (23), and `reencrypt-shuffle` — a re-encryption
   shuffle that's plaintext-preserving (can only reorder, never substitute), order-
   hiding, and cheat-evident on reveal (24, 7/7). Remaining is **non-crypto**: deal/
   reveal orchestration over the relay log + serving noble to the browser + UI.
5. Table UI driving 1–4 (post moves, replay via `betting.js`, render) — ⬜ wiring
6. Reduce → settle → escrow — ✅ proven (iter 16 + earlier)

**Deal coordinated over a signed-log message flow (iter 27).** `hand-deal-protocol.js`
turns the deal into JSON log payloads (`mp-key` / `mp-deck` / `mp-shuffle` / `mp-share`,
points hex-encoded) + a `dealStateFromLog` replay. Verified (5/5) with two seats posting
to a shared log: both replay to the **identical** joint key + shuffled deck; each opens
its own hole cards + the board from the log; all 9 are distinct; **from the log alone an
opponent cannot reconstruct your hole cards**; reveal-share proofs verify on replay.
These payloads map 1:1 to `relay-table-client.postMove`, so the deal runs over the real
relay log. Remaining: interleave betting (`betting.js` actions as moves) + showdown
reveal → reduce → settle, plus the table UI.

**Deal engine built + verified (iter 26).** `mental-deal.js` orchestrates a full hand
deal from the proven primitives: encrypt the deck to the joint key → both seats
shuffle (reencrypt-shuffle) → deal hole/board by layout → reveal hole cards privately
(owner + others' proven shares) and the board publicly. Verified a 2-seat deal (5/5):
each seat privately opens its 2 hole cards, the board shows 5 public cards, all 9 are
distinct from one deck, and **an opponent genuinely cannot see your hole cards**.
Remaining is coordination, not crypto: drive these steps as signed moves over the
relay log (relay-table-client) interleaved with betting (betting.js) and showdown →
reduce → settle, plus the table UI.

**Browser crypto now actually loads (iter 25).** The recurring blocker — the mental-
poker modules import noble (`@noble/curves`, `@noble/hashes`), unbundlable here — is
solved without a bundler: vendored the noble `.js` trees under `money/vendor/noble/`
and extended the `/poker-engine/` route to serve the `noble/**` subtree (`.js`-only,
traversal-guarded), resolved client-side by an **import map**. Verified the browser
loads the full 24-file noble graph (relative + cross-package imports all resolve) and
a point op matches Node byte-for-byte; the real relay serves it (200) while blocking
traversal + non-js (404). So `ed25519-noble`/`chaum-pedersen-browser`/`elgamal-deck`/
`reencrypt-shuffle` can now run in-browser. Remaining: serve those crypto modules
(straightforward whitelist) + deal/reveal orchestration + table UI.

## Browser table client — module BUILT + verified (iteration 18)

Wrote `money/relay-table-client.js` (served same-origin via `/poker-engine`) — the
browser module that makes the dashboard a real seat. WebCrypto Ed25519 (no vendored
crypto) signs moves the relay accepts; works in any secure context (localhost dev +
https prod). API: `createSeat()` / `restoreSeat()` (persist a seat across reloads,
PKCS8), `signEntry()`, and a `RelayTable` wrapper (`createTable`/`postMove`/`readLog`/
`listTables`).

Verified end-to-end in a browser on the **real relay** (same-origin, localhost
secure): `createTable` → 201; a WebCrypto-signed move → accepted + in the shared log;
a tampered signature → 422; a **persisted seat key restores and re-signs** correctly;
no JS errors. (Also confirmed `crypto.subtle` Ed25519 is available on localhost — the
about:blank failure earlier was just a non-secure context.)

**Remaining for playable multiplayer:** a table UI that drives this client (create/
join, post each betting action as a signed move, poll the log, replay via
`betting.js`), plus trustless dealing (the relay is card-blind — the poker bundle
ships VRF for this). The networking + identity + signing layer is now done and
proven.

## Browser table client — DE-RISKED (iteration 17)

The one piece left for real two-human play is a browser client that signs + posts
moves to the relay log. Its only real unknown was **in-browser ed25519 signing** (the
relay verifies with sodium; browsers have no sodium). Proven solvable:

- **Canonical bytes** (`_canonicalEntry`) are plain string-concat + UTF-8 — reproduced
  in ~3 lines, byte-identical (the format is explicitly cross-runtime).
- **Signing**: `@noble/curves` ed25519 (pure JS, browser-ready) produces signatures
  the relay's `sodium.crypto_sign_verify_detached` **accepts** — verified against the
  local relay: create-table with a noble pubkey → 201; a noble-signed move → `{ok:true}`
  and lands in the log; a **tampered** signature is rejected (422 bad-sig).

So every layer of real multiplayer is now proven: canonical bytes ✓, browser ed25519
✓, relay table API ✓, reduce→settlement ✓ (iter 16), escrow on-chain ✓. **What's left
is pure wiring**: vendor a browser noble bundle, write a `relay-table-client.js`
(create/join, sign+post moves, poll the log), and render the table from the shared
log instead of local bots. No unsolved primitives remain.

## Multiplayer substrate — PROVEN on a local relay (iteration 16)

The remaining frontier (two humans, on-chain settlement) needs a relay table that
both players write to. Enabled the relay's built-in **poker service** locally
(`services.json: {enabled:true, plugins:["poker"]}` in `~/.hiverelay/storage`, which
expands to poker+vrf+arbitration+zk) and ran the relay-integration smoke
(`fra/play-on-fra.mjs`) against the **local** relay:

- `POST /api/poker/tables` (two writers) → **201**.
- Both seats `POST /api/poker/<key>/move` signed entries → **200** (log indices 0,1).
- `GET /api/poker/<key>/log` → 2 entries → `reduce()` → **`illegal: null`**,
  deterministic `sessionHash`, balances `{alice:+30, bob:−30}` → on-chain final
  **alice 130 / bob 70 USD₮**.

So a hand on the relay's signed log **reduces to exactly the settlement the escrow
pays** — the whole substrate (relay table API → signed log → reducer → on-chain
balances) works end-to-end locally. **What's left for real two-human play is the
browser table client** (post each action as a signed move + render from the shared
log instead of local bots); the relay API, the reducer, the escrow, and the settle
UI are all proven.

## Verified against a REAL relay node (iteration 15)

Everything before this was tested against a mocked static server. Booted an actual
local relay (`p2p-hiverelay start --port 8790`) and confirmed the whole money-rail
surface works when served by the **real `api.js`**, not a mock:

- `/lobby` `/table` `/cashier` all serve 200; the real CSP is
  `script-src 'self' 'unsafe-inline'` / `connect-src 'self' ws: wss:`.
- `/poker-engine/{betting.js, hand-eval.js, ethers.umd.min.js, poker-artifacts.json}`
  all serve 200 (artifacts as `application/json`); `/poker-engine/api.js` correctly
  404s — the whitelist holds against the real route.
- In a browser on the real relay: **ethers loads same-origin under the real CSP**
  (zero violations), artifacts fetch + parse, the self-serve **Deploy** button is
  wired, and the co-sign digest is **byte-valid** via real-relay-served ethers. So
  M2 (F10), the artifacts (F11), and the cashier live flow are confirmed in
  production-equivalent conditions, not just under the mock.
- **Local relay boots cleanly here** — so the multiplayer build *can* be developed +
  verified against a local relay (no need to touch the live FRA relay). That's the
  unblock for the remaining frontier.

## Certification (iteration 36 — full system, including multiplayer)

The complete two-human flow now exists and is green end-to-end:
- **Product suites:** off-chain **87/87** · on-chain **31** · routes **5/5** · api.js clean.
- **Full human-vs-human hand (two browsers, real relay):** **13/13** — handshake →
  trustless deal (private hole cards) → betting over the log → showdown → winner → net
  (zero-sum, bridged to the Cashier).
- **On-chain money:** shared 2-player escrow deploy → both deposit → `cooperativeClose`
  (both sigs) → withdraw → drains to 0 (**7/7** on a local EVM); solo self-serve deploy
  + faucet proven; both settlement paths proven on Base Sepolia earlier.

**What a tester can do on testnet today, self-served:** open `/cashier`, grab test USD₮
from the faucet, deploy a shared escrow with their opponent's address, both deposit;
open `/mp-table`, exchange invite/join codes, and play a complete trustless hold'em hand
against another human (each sees only their own cards); see the session net in the
Cashier and settle it on-chain via the cooperative close. Every layer — relay
transport, browser mental-poker crypto, deal/bet/showdown, and on-chain settlement — is
built and verified. The one remaining nicety is auto-carrying the net + opponent EVM
address into the settle form (today entered manually).

## Certification (iteration 10 — full regression sweep)

Everything reviewed across 10 iterations is green together, no regressions:

- **Product suites:** off-chain 83/83 · on-chain 31 passing · dashboard routes 5/5.
- **Browser flows (headless):** table net/badges, keyboard play, lobby→table,
  ethers-under-strict-CSP + co-sign digest, self-serve deploy + solo settle — all
  pass (31 assertions across 5 harnesses).
- **12 issues found & fixed + 4 platform wins** (hotkeys, same-origin ethers,
  self-serve escrow deploy, one-click solo settle). See below.

**What a real human can do on testnet today, self-served:** open `/lobby` → play
hold'em vs bots (hotkeys, net readout, mobile-friendly); open `/cashier` → Live →
*Deploy a test escrow* on Base Sepolia → deposit → settle → withdraw real testnet
USD₮, one click per step, with an on-chain-valid co-sign. **Nothing needed from the
operator.**

**The one remaining frontier (not built):** two real humans playing the same
real-money *hand* that settles on-chain. The table is a local bot demo; it isn't
joined to the relay (shared multiplayer state) or to the escrow (settling actual
gameplay). That needs the relay-multiplayer + table→reducer→escrow wiring — every
piece (betting engine, reducer, escrow, signed-log) exists and is tested
individually, but joining them needs a running relay (FRA key or a local relay
instance), so it can't be built+verified in this review loop. Scope below.

## Verified working (headless drive, 0 JS errors)

- **Table** — 2 / 6 / 9-max, full betting (fold/check/call/bet/raise/all-in +
  quick-bet), bots, side pots, street-by-street board, showdown by real hand
  strength, re-buy on bust, juice (badges, card-flip, ship, strength readout),
  sound toggle. Drove 12 hands mixing all actions incl. all-ins and a bust→re-buy —
  no errors. Drives the **real** engine over `/poker-engine`.
- **Cashier** — demo lifecycle (connect→deposit→settle→withdraw→new session),
  lifecycle stepper, win/loss banner, live-mode config + cooperative co-sign
  section, and the **table-session bridge** (reads the table's net from
  `localStorage` — correctly showed "-1090 over 5 hands").
- **Lobby / hub / nav / routing** — all pages reachable, cross-linked; HTTP nav
  verified end to end.
- **On-chain escrow** — BOTH settlement paths proven on Base Sepolia (cooperative +
  committee dispute), escrow drains to 0 each time. Suites: 83 off-chain + 31
  on-chain + 5 routing, all green.
- **Cashier live co-sign is on-chain-valid** — the in-browser `coopDigestHex` is
  **byte-identical** to `settle.cjs` (verified `0x883c9c90…` for a fixed input), and
  an EIP-191 signature over it recovers to the signer (matches the contract's
  `_recover`). So a real tester's cooperative co-sign produced in the browser will
  verify on-chain. The live deposit/withdraw/connect paths mirror the tested
  `EscrowClient`, with failures surfaced to the activity log.

## Bugs found & fixed (this review)

- **F1 — "Net this session" stuck at 0.** The N-seat rewrite dropped the `#net`
  update in `render()`; `T.net` was computed + persisted but never shown, so a
  money tester couldn't see winnings/losses. **Fixed** (render writes it; green/red;
  no `+` on zero). Verified: shows -1000 after busting an all-in.
- **F2 — stale badges/ship into the next hand.** Action badges and the pot-ship
  lingered onto a fresh deal. **Fixed** (cleared at `startHand`). Verified: 0 stale
  elements at a fresh deal.
- **F3 — bot name "Юki"** had a stray Cyrillic char. **Fixed** → "Quinn".
- **F4 — cashier live-mode count-up flash.** Demo→live animated the stats down from
  the demo numbers (~0.4s flash). **Fixed** (snap the displays on mode switch).
  Verified: live wallet shows 0.00 immediately.
- **F5 — 9-max clipped a seat on mobile.** On a phone, a side seat's cards ran off
  the edge at 9-max (6-max + heads-up were fine). **Fixed** (pull seats inward on
  narrow screens — smaller seat radius < 560px). Verified: 0 clipped at 9-max,
  6-max still 0 clipped + playable, 0 JS errors on mobile.

- **F6 — live deposit could revert on a laggy testnet RPC.** `liveDeposit` approved
  then immediately deposited; on a public RPC that lags read-after-write (the exact
  failure I hit deploying to Base Sepolia), `deposit`'s gas estimate sees a stale
  allowance and reverts `TRANSFER_FROM_FAILED`. **Fixed** (poll the allowance to
  propagate after approve, like the proven scripts). Matters directly for real
  testnet testing.

- **F7 — a bad bot decision can no longer hang the table.** `botStep` applied
  `botDecide`'s action without checking the result; if it ever emitted an illegal
  action (future edit / unforeseen edge), the same seat would be asked forever and
  the table would hang — the worst live-testing experience. Now falls back to a
  guaranteed-legal action (check / call / all-in). Defensive; `botDecide` is legal
  today (bet/raise clamped to `[minRaiseTo, maxRaiseTo]`).

- **F8 — stale "heads-up" copy.** The hub headline and lobby intro both said
  "heads-up hold'em" although the product plays 2–9 handed — wrong expectations on a
  first-time player's very first screen. **Fixed** → "real-money hold'em (2–9
  handed)" on both.

- **F9 — added poker hotkeys (table was mouse-only).** Serious players act on
  keys, not the mouse. Added **F** fold · **C**/**Space** check-call · **R**
  bet/raise · **A** all-in · **Enter** next hand, with a discoverable hint under the
  controls. A key only fires when its control is enabled + visible, so out-of-turn
  keys are no-ops (same guard as clicks) and typing in inputs/selects is never
  hijacked. Verified headless: keys drive actions, Enter advances hands, out-of-turn
  keypresses leave the pot unchanged, 0 JS errors.

## Surfaces note

- **Payments** in the topbar is the *relay's* credits/Lightning page (shared relay
  nav), not poker — the poker money flow is the **Cashier**. Buttons are native
  `<button>`s (keyboard-focusable, Enter/Space activate), so base accessibility is
  sound; the new hotkeys add power-user keyboard play. A deeper ARIA/tab-order pass
  remains a future nicety.

- **F13 — lobby "Create a table" over-promised.** The card read "Pick stakes &
  invite a friend" but just opened the bot table — no stakes picker, no invite
  (multiplayer isn't built). Honest now: **"Practice table — Jump in vs bots, live
  multiplayer soon."**

## Reload & persistence (verified)

- **Reload mid-hand is graceful** — refreshing during a hand re-renders all seats and
  deals a fresh, playable hand with no errors (the table always starts a clean
  session; it never tries to resume a half-finished hand).
- **Session net persists at hand-end only** (`finishBetting` → `localStorage`), which
  the lobby + cashier read as the session-net bridge. A reload doesn't wipe it (the
  table never writes 0 on boot), and the lobby/cashier handle a missing value as `+0`.

## Lobby → table flow + first-time experience (verified)

- **Sit-down opens the chosen size** — every lobby table's `max` is in {2,6,9}; the
  table parses `?seats=` and validates (anything else → 6-max). Drove it: 9-max
  sit-down → `?seats=9` → table opens with 9 seats; heads-up → 2. Full tables show a
  disabled "Table full". All 6 nav links resolve.
- **The lobby is a clear first-time entry** — headline ("Real-money poker, no
  operator holding your chips"), the Sit down → Play → Settle net → Cash out flow,
  live table cards with seat-occupancy dots and open/full/in-hand badges, and a live
  session-net stat. A newcomer instantly knows to pick a table and sit.
- **Tester entry point:** `/dashboard` is the relay's *ops* dashboard with a poker
  banner on top (prominent, with Lobby/Play/Cashier CTAs). For a focused poker test,
  point testers straight at **`/lobby`** — the cleanest poker-first surface.
- **Pages degrade gracefully** — the relay-backend `fetch`es (`/api/overview`, credit
  pricing, etc.) and `/poker-engine` 404 only under a bare static server (no relay);
  the pages catch the failures and render fine — no uncaught JS errors.

## Table edge cases (verified)

- **Out-of-turn clicks are safe** — force-dispatching a click on an action button
  when it isn't your turn is a no-op (handlers guard on `toAct === 'you'`; the pot is
  unchanged). Disabled buttons don't fire anyway.
- **Result messages are correct** for both paths: contested showdown → "X wins N with
  `<category>`" (+ winning-card glow); uncontested → "X takes N — everyone folded".
  No empty/NaN/negative amounts seen.
- **Controls match poker rules** — `bCall` is always enabled on your turn (labelled
  "Check" when you owe nothing, "Call N" otherwise); `bFold` is correctly disabled in
  check spots (no folding when checking is free). The table correctly waits for the
  human ("Your move.").
- **Demo cashier math is sound** — top-ups accumulate; a session can never lose more
  than its bankroll (`net ≥ -bankroll` ⇒ `withdrawable ≥ 0`); winnings carry to the
  next session.
- **Bet controls never produce a dead click** — the slider range is pinned to the
  engine's `[minRaiseTo, maxRaiseTo]` (step BB) and the ½-pot/pot/max quick-bets clamp
  to it. Drove 38 raises (slider min, all-in, pot, half) across 14 hands: **0 dead
  clicks** — every Raise advanced the game, and the slider value was always within
  the legal range. So "I clicked Raise and nothing happened" can't occur.

## Card + hand display — what you see is what's scored (verified)

A player bets on what they think they hold, so the cards shown and the hand named
must match the evaluator exactly:

- **Cards.** `cardEl` renders rank/suit from the **same** `cardRank`/`cardSuit` the
  engine evaluates with, so the displayed card is provably the scored card (no
  divergence possible). Colour (`isRed`) is correct: hearts + diamonds red.
- **Hand readout.** The "You have: …" `handName()` and the showdown category `CAT[]`
  both index `[0..12]` (Two…Ace), matching the evaluator's rank tuple. Checked 12
  known hands incl. the tricky ones — the A-2-3-4-5 wheel reads "Straight, Five high"
  (ace low), broadway reads "Ace high", quads/full house/flush/two-pair all named
  right; all 52 indices map to a named rank. 12/12 correct.

## Side-pot payouts — proven correct (real-money critical)

The table has its **own inline `distribute()`** (the reducer pulls in sodium and
isn't browser-importable), so when players go all-in for different amounts the
browser computes the side pots itself — a divergence here would misallocate real
money. Verified it can't diverge: it aliases the reducer's exact `evaluate7`/
`compareRank` (same `hand-eval.js`), and an **8000-scenario fuzz** (4671 contested
multi-level side-pots, plus fold-wins, dead money from folders, uncalled-bet
refunds, and ties) shows `distribute()` produces **identical payouts to the tested
`reducer.settleHand` on every scenario — zero mismatches**. (Exported `settleHand`
for the comparison; off-chain suite stays 83/83.)

## Mobile

6-max and heads-up play cleanly on a 390px phone (no clipped/overlapping seats,
controls usable, 0 errors). 9-max is inherently tight on a phone but now fits after
F5. The action bar stacks full-width.

- **F10 — cashier Live mode now works relay-served (CSP untouched).** Was M2: the
  cashier loaded `ethers` from a CDN that the relay CSP (`script-src 'self'`) refuses
  when served through the relay, so Live mode only worked opened directly (file://).
  **Fixed** by vendoring `ethers.umd.min.js` into the money dir and serving it
  same-origin through the existing `/poker-engine/` whitelist; the cashier now loads
  `/poker-engine/ethers.umd.min.js`. Verified headless under the **strict relay CSP**:
  ethers loads (a CDN script would be refused), zero CSP violations, and the co-sign
  digest still byte-matches `settle.cjs` with the vendored 6.17.0. CSP stays
  `script-src 'self'` — no relaxation; the injected wallet does RPC so `connect-src`
  stays tight too.

- **F11 — self-serve testnet escrow (removes the last setup dependency).** A tester
  used to need *me* to deploy them an escrow with their address as a seat. Added a
  **"Deploy a test escrow + mint USD₮"** button to the cashier's Live mode: connect
  MetaMask on Base Sepolia and it deploys MockUSDT + PokerEscrow (you as the sole
  seat) and mints 1,000 test USD₮ — then deposit → settle → withdraw proves the whole
  on-chain rail, entirely self-served. Vendored the contract artifacts
  (`poker-artifacts.json`, served same-origin via the `/poker-engine/` whitelist).
  Verified: the vendored bytecode deploys + runs a full deposit→cooperativeClose→
  withdraw cycle on a real EVM (8 assertions, conservation held, solo seat + single
  sig works); in-browser the artifacts load + parse under the strict relay CSP, the
  button is wired, clicking without a wallet logs a clear instruction (no crash), and
  the cashier still works. Suites stay green (83 + 31 + 5).

- **F12 — solo self-test settle is now one-click.** The self-serve deploy makes a
  *solo* escrow, but the cooperative-settle section is built for multi-party
  ("0xAlice…,0xBob…" / "150,50") — a solo tester wouldn't know to type their own
  address + deposit. Now after deploy the payee auto-fills to your address and, once
  you deposit, your settle balance auto-fills to your bankroll — so the loop is
  Deposit → Sign → Submit → Withdraw with nothing to figure out. Guarded so it never
  overwrites a multi-party entry or an amount you typed. Verified: solo fills to
  100.00, "60,40" untouched, "999" not clobbered.

- **F14 — testnet USD₮ faucet for new players.** Added a **"Get 1,000 test USD₮"**
  button to the cashier's Live mode: it mints MockUSDT (permissionless `mint`) to the
  connected wallet on Base Sepolia, so a newcomer has chips to play with without
  deploying their own escrow (and can claim again to top up). The "Deploy a test
  escrow" button already mints 1,000 on deploy; the faucet covers the case of playing
  against an existing escrow. Verified: button present/wired/graceful (no token → clear
  instruction, no crash, no CSP violations), and the mint via the cashier's `ERC20_ABI`
  funds a wallet on a real EVM (1,000, then 2,000 on a second claim).

## Open / minor

_None outstanding from the demo-surface + on-chain-path review._ The only remaining
work is the big build below (real end-to-end on-chain play) and the operator inputs
it needs.

## Readiness for REAL human testing on testnet — the honest picture

The on-chain rail is **proven** and the gameplay UI is **solid**, but the pieces are
not yet wired into one playable real-money game:

| Test a human can run today | Status |
|---|---|
| **Gameplay UX** — play Hold'em vs bots at `/table` | ✅ ready (now with a correct net readout) |
| **On-chain money rail** — deposit → settle → withdraw real testnet USD₮ | ✅ **now fully self-serve in-browser** (F10+F11): MetaMask on Base Sepolia → "Deploy a test escrow" → deposit/settle/withdraw. No setup, no input from anyone. |
| **Full real-money game** — two humans play a hand that settles on-chain | ❌ **not wired** — see below |

**The core gap.** The demo table plays **locally vs bots** — it does **not** connect
to the relay (no real multiplayer) or to the escrow (no on-chain settlement of
actual gameplay). The cashier is a **separate manual** on-chain flow. So "two real
humans sit, play a real-money hand, and it settles on-chain" does not exist yet.
That end-to-end loop needs the **relay-multiplayer + table→reducer→escrow wiring**
(the Phase-06 / integration piece) — the betting engine, reducer, escrow, and relay
signed-log all exist and are tested individually, but nothing joins them into a
single real-money table.

## Recommended next steps (for a real human test)

1. ✅ **Done** across iterations 1–9: net display, stale badges, names, mobile 9-max,
   deposit RPC-lag, hung-table guard, heads-up copy, keyboard hotkeys, same-origin
   ethers (M2/F10), self-serve escrow deploy (F11), one-click solo settle (F12).
2. ✅ **Interactive on-chain test** — no longer needs the operator: the cashier's
   "Deploy a test escrow" button provisions everything from the tester's own wallet.
3. **The remaining frontier — real multiplayer money game.** Concrete scope:
   - **Shared table state.** Join the table to the relay's signed log so two humans
     see one game. `fra/play-on-fra.mjs` already drives the real relay's log →
     reducer; the table needs to (a) create/join a relay table, (b) post each action
     as a signed log entry, (c) render from the shared log instead of local bots.
     Needs a running relay — the **FRA management key** (live relay, operator-gated)
     or a **local relay instance** to develop against.
   - **Settle real gameplay.** On hand/session end, run `reducer.js` over the signed
     log → net balances → the cashier's existing `cooperativeClose` (co-sign) or
     `disputeClose` (committee) path. The settle digest is already on-chain-valid
     (verified), so this is wiring the reducer output into the (working) settle UI.
   - **Seat ↔ wallet binding.** Each seat's relay identity maps to its on-chain
     address (escrow participant), so the reduced balances settle to the right payees.
   - **Effort:** multi-day; needs relay access to build+verify. Everything *below*
     this line (engine, reducer, escrow, settle, signed-log) exists and is tested —
     this is integration, not new primitives.
