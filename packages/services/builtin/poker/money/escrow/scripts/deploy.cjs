// deploy.cjs — deploy the P2Poker escrow to a testnet (or local).
//   npx hardhat run scripts/deploy.cjs --network testnet
//   npx hardhat run scripts/deploy.cjs                 (in-process local node)
//
// Env (all optional — sensible defaults for a smoke test):
//   USDT_ADDRESS    use an existing test USD₮; if unset, deploys MockUSDT and
//                   mints 1,000 to the deployer.
//   PARTICIPANTS    comma-separated settlement addresses (default: [deployer]).
//   COMMITTEE       comma-separated relay attestor addresses (default: []).
//   THRESHOLD       committee m-of-n (default: COMMITTEE.length).
//   EXPIRY_HOURS    unilateral-exit window (default: 24).
//   ESCROW_LABEL    string hashed into escrowId (default: "p2poker-testnet").

const { ethers } = require('hardhat')

async function main () {
  const [deployer] = await ethers.getSigners()
  const net = await ethers.provider.getNetwork()
  console.log('deployer:', deployer.address, '| chainId:', net.chainId.toString())
  const bal = await ethers.provider.getBalance(deployer.address)
  console.log('gas balance:', ethers.formatEther(bal), 'ETH')
  if (bal === 0n) throw new Error('deployer has no gas — fund the key from a faucet first')

  let usdt = process.env.USDT_ADDRESS
  if (!usdt) {
    const USDT = await ethers.getContractFactory('MockUSDT')
    const c = await USDT.deploy(); await c.waitForDeployment()
    usdt = await c.getAddress()
    await (await c.mint(deployer.address, 1000n * 1_000_000n)).wait()
    console.log('MockUSDT deployed:', usdt, '(minted 1,000 to deployer)')
  } else {
    console.log('using USD₮:', usdt)
  }

  const participants = (process.env.PARTICIPANTS || deployer.address).split(',').map(s => s.trim()).filter(Boolean)
  const committee = (process.env.COMMITTEE || '').split(',').map(s => s.trim()).filter(Boolean)
  const threshold = process.env.THRESHOLD ? Number(process.env.THRESHOLD) : committee.length
  const expiryHours = process.env.EXPIRY_HOURS ? Number(process.env.EXPIRY_HOURS) : 24
  const now = (await ethers.provider.getBlock('latest')).timestamp
  const escrowId = ethers.id(process.env.ESCROW_LABEL || 'p2poker-testnet')

  const Escrow = await ethers.getContractFactory('PokerEscrow')
  const escrow = await Escrow.deploy(escrowId, usdt, participants, committee, threshold, now + expiryHours * 3600)
  await escrow.waitForDeployment()
  const addr = await escrow.getAddress()

  console.log('\n=== PokerEscrow deployed ===')
  console.log('escrow:      ', addr)
  console.log('escrowId:    ', escrowId)
  console.log('usdt:        ', usdt)
  console.log('participants:', participants.join(', '))
  console.log('committee:   ', committee.length ? committee.join(', ') : '(none — cooperative+exit only)')
  console.log('threshold:   ', threshold)
  console.log('expiry:      ', new Date((now + expiryHours * 3600) * 1000).toISOString())
  console.log('\nnext: each participant approve()+deposit() their bankroll, play off-chain, then cooperativeClose / disputeClose.')
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
