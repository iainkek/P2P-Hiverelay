// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// An ERC-20 that burns a 1% fee on every transfer (fee-on-transfer). TEST ONLY —
// proves PokerEscrow credits the MEASURED received amount on deposit, so pot()
// never exceeds the real balance and no withdrawal is left stranded.
contract FeeToken {
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function _fee(uint256 a) internal pure returns (uint256) { return a / 100; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }

    function transfer(address t, uint256 a) external returns (bool) {
        uint256 f = _fee(a);
        balanceOf[msg.sender] -= a;
        balanceOf[t] += a - f; // fee burned
        return true;
    }

    function transferFrom(address from, address t, uint256 a) external returns (bool) {
        allowance[from][msg.sender] -= a;
        uint256 f = _fee(a);
        balanceOf[from] -= a;
        balanceOf[t] += a - f; // fee burned
        return true;
    }
}
