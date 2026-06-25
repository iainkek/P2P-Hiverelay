// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// A malicious ERC-20 whose transfer() re-enters the escrow. TEST ONLY — proves
// PokerEscrow resists reentrancy (CEI: `closed` flips before payout; plus the
// nonReentrant guard). The re-entry is wrapped in try/catch so the attack does
// not just revert the whole tx — it records whether the re-entry was blocked.
interface IEscrowAttack {
    function unilateralExit() external;
}

contract ReentrantToken {
    string public symbol = "EVIL";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public escrow;
    bool public armed;
    bool public reentryReverted;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }

    function arm(address e) external { escrow = e; armed = true; }

    function transfer(address t, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[t] += a;
        if (armed) {
            armed = false; // one-shot
            try IEscrowAttack(escrow).unilateralExit() {
                // re-entry SUCCEEDED — escrow is vulnerable
            } catch {
                reentryReverted = true; // re-entry blocked — escrow is safe
            }
        }
        return true;
    }
}
