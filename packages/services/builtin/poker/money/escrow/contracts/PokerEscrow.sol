// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// PokerEscrow — state-channel escrow for real-money P2Poker (Phase 08 build,
// from the Phase 01 decision). UNAUDITED. Each seat deposits a USD₮ session
// bankroll; play happens off-chain on the HiveRelay signed log; the channel
// closes one of three ways:
//   - cooperativeClose: every participant signs the final balances (n-of-n).
//   - disputeClose:     a HiveRelay committee m-of-n attestation over the
//                       canonical outcome (sessionHash) settles the channel.
//   - unilateralExit:   after expiry anyone can force return of deposits, so
//                       funds can never be frozen.
// Signatures are EIP-191 personal-sign over an abi.encode digest, recovered via
// ecrecover (Phase 03 may switch the committee path to a BLS aggregate).

interface IERC20 {
    function transferFrom(address f, address t, uint256 a) external returns (bool);
    function transfer(address t, uint256 a) external returns (bool);
}

contract PokerEscrow {
    IERC20 public immutable token;
    bytes32 public immutable escrowId;
    uint256 public immutable expiry;
    uint256 public immutable committeeThreshold;

    address[] public participants;
    mapping(address => bool) public isParticipant;
    mapping(address => uint256) public deposited;
    mapping(address => bool) public isCommittee;

    uint256 public lastEpoch;
    bool public closed;

    event Opened(bytes32 escrowId);
    event Funded(address seat, uint256 amount);
    event Closed(string kind);

    modifier open() {
        require(!closed, "CLOSED");
        _;
    }

    // Reentrancy guard (defense-in-depth; the close functions also follow
    // checks-effects-interactions and flip `closed` before any token transfer).
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
        uint256 _committeeThreshold,
        uint256 _expiry
    ) {
        escrowId = _escrowId;
        token = _token;
        for (uint256 i = 0; i < _participants.length; i++) {
            participants.push(_participants[i]);
            isParticipant[_participants[i]] = true;
        }
        for (uint256 i = 0; i < _committee.length; i++) isCommittee[_committee[i]] = true;
        // threshold 0 ⇒ no committee / dispute path disabled (cooperative + exit only).
        require(_committeeThreshold <= _committee.length, "BAD_THRESHOLD");
        committeeThreshold = _committeeThreshold;
        expiry = _expiry;
        emit Opened(_escrowId);
    }

    function deposit(uint256 amount) external open nonReentrant {
        require(isParticipant[msg.sender], "NOT_SEAT");
        require(token.transferFrom(msg.sender, address(this), amount), "XFER");
        deposited[msg.sender] += amount;
        emit Funded(msg.sender, amount);
    }

    function cooperativeClose(
        address[] calldata payees,
        uint256[] calldata balances,
        bytes[] calldata sigs
    ) external open nonReentrant {
        require(payees.length == balances.length, "LEN");
        bytes32 digest = keccak256(abi.encode(escrowId, payees, balances));
        require(_allParticipantsSigned(digest, sigs), "NOT_ALL_SIGNED");
        _conserves(balances);
        closed = true; // effect before interaction (CEI); `open` also blocks re-close
        emit Closed("cooperative");
        _payout(payees, balances);
    }

    function disputeClose(
        bytes32 sessionHash,
        uint256 epoch,
        address[] calldata payees,
        uint256[] calldata balances,
        bytes[] calldata committeeSigs
    ) external open nonReentrant {
        require(committeeThreshold > 0, "DISPUTE_DISABLED");
        require(epoch > lastEpoch, "STALE_EPOCH");
        bytes32 digest = keccak256(abi.encode(escrowId, sessionHash, payees, balances, epoch));
        require(_committeeQuorum(digest, committeeSigs), "NO_QUORUM");
        _conserves(balances);
        lastEpoch = epoch;
        closed = true; // CEI
        emit Closed("dispute");
        _payout(payees, balances);
    }

    function unilateralExit() external open nonReentrant {
        require(block.timestamp >= expiry, "NOT_EXPIRED");
        closed = true; // CEI: flip before refunds; deposits are also zeroed per-seat
        emit Closed("exit");
        for (uint256 i = 0; i < participants.length; i++) {
            uint256 amt = deposited[participants[i]];
            if (amt > 0) {
                deposited[participants[i]] = 0;
                require(token.transfer(participants[i], amt), "REFUND");
            }
        }
    }

    // ── helpers ────────────────────────────────────────────────────────
    function pot() public view returns (uint256 p) {
        for (uint256 i = 0; i < participants.length; i++) p += deposited[participants[i]];
    }

    function _payout(address[] calldata payees, uint256[] calldata balances) internal {
        for (uint256 i = 0; i < payees.length; i++) {
            if (balances[i] > 0) require(token.transfer(payees[i], balances[i]), "PAYOUT");
        }
    }

    function _conserves(uint256[] calldata balances) internal view {
        uint256 sum;
        for (uint256 i = 0; i < balances.length; i++) sum += balances[i];
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

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        bytes32 eth = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        require(sig.length == 65, "SIG_LEN");
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        return ecrecover(eth, v, r, s);
    }
}
