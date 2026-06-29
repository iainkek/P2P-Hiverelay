// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// PokerEscrow — deposit / play / withdraw-net escrow for real-money P2Poker.
// UNAUDITED. Operates like a normal poker service:
//   - deposit:  each seat funds a USD₮ bankroll into the contract.
//   - play:     off-chain on the HiveRelay signed log.
//   - settle:   the session's NET balances are recorded ONCE, either by all
//               participants co-signing (cooperativeClose) or by a HiveRelay
//               committee m-of-n attestation over the canonical outcome
//               (disputeClose). Balances must conserve the pot.
//   - withdraw: each seat PULLS its settled net. If you never withdraw, you get
//               nothing.
//
// There is NO unilateral deposit-refund: your bankroll is at risk during play
// and you can only ever take out your settled NET — you cannot reclaim your full
// deposit to escape a loss. Liveness is the committee's job: the dispute path
// settles from the signed log without any player's cooperation, and an aborted
// session simply settles to net = deposit for everyone.
//
// Signatures are EIP-191 personal-sign over an abi.encode digest, recovered via
// ecrecover (a future revision may switch the committee path to a BLS aggregate).

interface IERC20 {
    function transferFrom(address f, address t, uint256 a) external returns (bool);
    function transfer(address t, uint256 a) external returns (bool);
}

contract PokerEscrow {
    IERC20 public immutable token;
    bytes32 public immutable escrowId;
    uint256 public immutable committeeThreshold;

    address[] public participants;
    mapping(address => bool) public isParticipant;
    mapping(address => uint256) public deposited;
    mapping(address => bool) public isCommittee;
    mapping(address => uint256) public withdrawable; // settled net; pull-based

    uint256 public lastEpoch;
    bool public settled;

    event Opened(bytes32 escrowId);
    event Funded(address seat, uint256 amount);
    event Settled(string kind);
    event Withdrawn(address seat, uint256 amount);

    // Reentrancy guard (defense-in-depth; deposit/withdraw also follow CEI).
    bool private _entered;
    modifier nonReentrant() {
        require(!_entered, "REENTRANT");
        _entered = true;
        _;
        _entered = false;
    }

    constructor(
        bytes32 _escrowId,
        IERC20 _token,
        address[] memory _participants,
        address[] memory _committee,
        uint256 _committeeThreshold
    ) {
        escrowId = _escrowId;
        token = _token;
        for (uint256 i = 0; i < _participants.length; i++) {
            require(_participants[i] != address(0), "ZERO_SEAT");
            participants.push(_participants[i]);
            isParticipant[_participants[i]] = true;
        }
        for (uint256 i = 0; i < _committee.length; i++) {
            require(_committee[i] != address(0), "ZERO_COMMITTEE");
            isCommittee[_committee[i]] = true;
        }
        // threshold 0 ⇒ no committee / dispute path disabled (cooperative only).
        require(_committeeThreshold <= _committee.length, "BAD_THRESHOLD");
        committeeThreshold = _committeeThreshold;
        emit Opened(_escrowId);
    }

    function deposit(uint256 amount) external nonReentrant {
        require(!settled, "SETTLED");
        require(isParticipant[msg.sender], "NOT_SEAT");
        _safeTransferFrom(msg.sender, address(this), amount);
        deposited[msg.sender] += amount;
        emit Funded(msg.sender, amount);
    }

    // Settle to NET balances. No payout here — seats pull via withdraw().
    function cooperativeClose(
        address[] calldata payees,
        uint256[] calldata balances,
        bytes[] calldata sigs
    ) external {
        require(!settled, "SETTLED");
        require(payees.length == balances.length, "LEN");
        bytes32 digest = keccak256(abi.encode(escrowId, payees, balances));
        require(_allParticipantsSigned(digest, sigs), "NOT_ALL_SIGNED");
        _record(payees, balances);
        settled = true;
        emit Settled("cooperative");
    }

    function disputeClose(
        bytes32 sessionHash,
        uint256 epoch,
        address[] calldata payees,
        uint256[] calldata balances,
        bytes[] calldata committeeSigs
    ) external {
        require(!settled, "SETTLED");
        require(committeeThreshold > 0, "DISPUTE_DISABLED");
        require(epoch > lastEpoch, "STALE_EPOCH");
        bytes32 digest = keccak256(abi.encode(escrowId, sessionHash, payees, balances, epoch));
        require(_committeeQuorum(digest, committeeSigs), "NO_QUORUM");
        lastEpoch = epoch;
        _record(payees, balances);
        settled = true;
        emit Settled("dispute");
    }

    // Pull your settled net. CEI: zero before transfer; nonReentrant on top.
    function withdraw() external nonReentrant {
        require(settled, "NOT_SETTLED");
        uint256 amt = withdrawable[msg.sender];
        require(amt > 0, "NOTHING");
        withdrawable[msg.sender] = 0;
        _safeTransfer(msg.sender, amt);
        emit Withdrawn(msg.sender, amt);
    }

    // ── helpers ────────────────────────────────────────────────────────
    function pot() public view returns (uint256 p) {
        for (uint256 i = 0; i < participants.length; i++) p += deposited[participants[i]];
    }

    // Record the settled net per payee, enforcing conservation (Σ balances ==
    // pot, so total withdrawable never exceeds what was deposited) and that every
    // payee is a seat (funds can only ever return to the players at the table).
    function _record(address[] calldata payees, uint256[] calldata balances) internal {
        uint256 sum;
        for (uint256 i = 0; i < balances.length; i++) {
            require(isParticipant[payees[i]], "PAYEE_NOT_SEAT");
            sum += balances[i];
            if (balances[i] > 0) withdrawable[payees[i]] += balances[i];
        }
        require(sum == pot(), "NOT_CONSERVED");
    }

    function _allParticipantsSigned(bytes32 digest, bytes[] calldata sigs) internal view returns (bool) {
        if (sigs.length != participants.length) return false;
        for (uint256 p = 0; p < participants.length; p++) {
            bool found;
            for (uint256 s = 0; s < sigs.length; s++) {
                if (_recover(digest, sigs[s]) == participants[p]) {
                    found = true;
                    break;
                }
            }
            if (!found) return false;
        }
        return true;
    }

    function _committeeQuorum(bytes32 digest, bytes[] calldata sigs) internal view returns (bool) {
        uint256 count;
        address last;
        for (uint256 s = 0; s < sigs.length; s++) {
            address signer = _recover(digest, sigs[s]);
            require(uint160(signer) > uint160(last), "UNSORTED_OR_DUP");
            last = signer;
            if (isCommittee[signer]) count++;
        }
        return count >= committeeThreshold;
    }

    // SafeERC20-style transfers: tolerate non-standard tokens (e.g. mainnet
    // USDT) that return no value, while still reverting on an explicit `false`.
    function _safeTransfer(address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(abi.encodeWithSelector(token.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TRANSFER_FAILED");
    }

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(abi.encodeWithSelector(token.transferFrom.selector, from, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TRANSFER_FROM_FAILED");
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        bytes32 eth = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        require(sig.length == 65, "SIG_LEN");
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        return ecrecover(eth, v, r, s);
    }
}
