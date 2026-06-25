// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// PokerEscrow — Phase 01 SPIKE / reference only. UNAUDITED. Demonstrates the
// state-channel escrow from DECISION.md concretely; it is NOT production code
// (no reentrancy hardening review, no upgrade story, simplified accounting).
//
// Model: each seat deposits a USD₮ session bankroll. Play happens off-chain on
// the HiveRelay signed log. The channel closes one of three ways:
//   - cooperativeClose: every participant signs the final balances (n-of-n).
//   - disputeClose:     a HiveRelay committee m-of-n attestation over the
//                       canonical outcome (sessionHash) settles + slashes.
//   - unilateralExit:   after expiry, anyone can force return of deposits so
//                       funds can never be frozen.
//
// The point of this file is to pin the on-chain interface in interfaces.md and
// expose the one hard downstream constraint: the attestation signature scheme
// must be cheap to verify here (Phase 03 picks BLS-aggregate or k*ecrecover).

interface IERC20 {
    function transferFrom(address f, address t, uint256 a) external returns (bool);
    function transfer(address t, uint256 a) external returns (bool);
}

contract PokerEscrow {
    IERC20 public immutable token;          // USD₮
    address[] public participants;          // settlement addresses (sorted)
    mapping(address => uint256) public deposited;
    mapping(address => bool) public isParticipant;

    // HiveRelay attestor committee (dispute path). For the spike, secp256k1
    // addresses recovered via ecrecover; Phase 03 may switch to BLS aggregate.
    mapping(address => bool) public isCommittee;
    uint256 public committeeThreshold;

    uint256 public expiry;                  // ms epoch; unilateral exit after
    uint256 public lastEpoch;               // attestation anti-replay
    bool public closed;
    bytes32 public escrowId;

    event Opened(bytes32 escrowId);
    event Funded(address seat, uint256 amount);
    event Closed(string kind);

    modifier open() { require(!closed, "CLOSED"); _; }

    constructor(
        bytes32 _escrowId,
        IERC20 _token,
        address[] memory _participants,
        address[] memory _committee,
        uint256 _committeeThreshold,
        uint256 _expiry
    ) {
        escrowId = _escrowId;
        token = _token;
        participants = _participants;
        for (uint256 i = 0; i < _participants.length; i++) isParticipant[_participants[i]] = true;
        for (uint256 i = 0; i < _committee.length; i++) isCommittee[_committee[i]] = true;
        require(_committeeThreshold > 0 && _committeeThreshold <= _committee.length, "BAD_THRESHOLD");
        committeeThreshold = _committeeThreshold;
        expiry = _expiry;
        emit Opened(_escrowId);
    }

    function deposit(uint256 amount) external open {
        require(isParticipant[msg.sender], "NOT_SEAT");
        require(token.transferFrom(msg.sender, address(this), amount), "XFER");
        deposited[msg.sender] += amount;
        emit Funded(msg.sender, amount);
    }

    // Happy path: n-of-n signatures over (escrowId, balances). balances must
    // conserve the pot. Every participant must have signed.
    function cooperativeClose(
        address[] calldata payees,
        uint256[] calldata balances,
        bytes[] calldata sigs
    ) external open {
        require(payees.length == balances.length, "LEN");
        bytes32 digest = keccak256(abi.encode(escrowId, payees, balances));
        require(_allParticipantsSigned(digest, sigs), "NOT_ALL_SIGNED");
        _conservesPot(balances);
        _payout(payees, balances);
        closed = true;
        emit Closed("cooperative");
    }

    // Grief path: HiveRelay committee m-of-n attestation over the canonical
    // outcome. Spike verifies k secp256k1 sigs via ecrecover; Phase 03 may
    // replace with one BLS pairing check. `slash` redistributes bonds.
    function disputeClose(
        bytes32 sessionHash,
        uint256 epoch,
        address[] calldata payees,
        uint256[] calldata balances,
        bytes[] calldata committeeSigs
    ) external open {
        require(epoch > lastEpoch, "STALE_EPOCH");
        bytes32 digest = keccak256(abi.encode(escrowId, sessionHash, payees, balances, epoch));
        require(_committeeQuorum(digest, committeeSigs), "NO_QUORUM");
        _conservesPot(balances);
        lastEpoch = epoch;
        _payout(payees, balances);
        closed = true;
        emit Closed("dispute");
    }

    // Liveness: after expiry anyone can force return of each seat's deposit so
    // funds can never be frozen by a stalled close.
    function unilateralExit() external open {
        require(block.timestamp >= expiry, "NOT_EXPIRED");
        for (uint256 i = 0; i < participants.length; i++) {
            uint256 amt = deposited[participants[i]];
            if (amt > 0) { deposited[participants[i]] = 0; token.transfer(participants[i], amt); }
        }
        closed = true;
        emit Closed("exit");
    }

    // ── helpers (spike-grade) ──────────────────────────────────────────
    function _payout(address[] calldata payees, uint256[] calldata balances) internal {
        for (uint256 i = 0; i < payees.length; i++) {
            if (balances[i] > 0) require(token.transfer(payees[i], balances[i]), "PAYOUT");
        }
    }

    function _conservesPot(uint256[] calldata balances) internal view {
        uint256 sum;
        for (uint256 i = 0; i < balances.length; i++) sum += balances[i];
        uint256 pot;
        for (uint256 i = 0; i < participants.length; i++) pot += deposited[participants[i]];
        require(sum == pot, "NOT_CONSERVED");
    }

    function _allParticipantsSigned(bytes32 digest, bytes[] calldata sigs) internal view returns (bool) {
        if (sigs.length != participants.length) return false;
        // Each participant must appear exactly once among recovered signers.
        for (uint256 p = 0; p < participants.length; p++) {
            bool found;
            for (uint256 s = 0; s < sigs.length; s++) {
                if (_recover(digest, sigs[s]) == participants[p]) { found = true; break; }
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
            require(signer > last, "UNSORTED_OR_DUP"); // sorted + unique → no double-count
            last = signer;
            if (isCommittee[signer]) count++;
        }
        return count >= committeeThreshold;
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        bytes32 eth = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (bytes32 r, bytes32 s, uint8 v) = _split(sig);
        return ecrecover(eth, v, r, s);
    }

    function _split(bytes calldata sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "SIG_LEN");
        r = bytes32(sig[0:32]);
        s = bytes32(sig[32:64]);
        v = uint8(sig[64]);
    }
}
