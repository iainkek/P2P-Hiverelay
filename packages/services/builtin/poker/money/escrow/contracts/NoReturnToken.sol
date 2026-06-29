// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// A USD₮-like ERC-20 whose transfer / transferFrom return NO value, exactly like
// mainnet Tether (USDT). TEST ONLY — proves PokerEscrow's SafeERC20-style
// transfer handling works against non-standard tokens.
contract NoReturnToken {
    string public symbol = "USDT0";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; } // no return
    function transfer(address t, uint256 a) external { // no return value
        balanceOf[msg.sender] -= a;
        balanceOf[t] += a;
    }
    function transferFrom(address f, address t, uint256 a) external { // no return value
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
    }
}
