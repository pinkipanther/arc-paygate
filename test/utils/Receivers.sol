// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PayGate} from "../../src/PayGate.sol";

/// @dev Seller/recipient whose receive hook always reverts (misconfigured multisig, EIP-7702
///      delegate without a payable fallback, ...). On Arc, "sending native value to a contract
///      isn't guaranteed to succeed", so this is a realistic seller.
contract RevertingReceiver {
    PayGate immutable GATE;

    constructor(PayGate g) { GATE = g; }

    function create(uint96 price, uint32 window) external returns (uint256) {
        return GATE.createResource(price, window, "reverting");
    }

    function withdraw() external { GATE.withdraw(); }

    function withdrawTo(address payable to) external { GATE.withdrawTo(to); }

    receive() external payable { revert("no thanks"); }
}

/// @dev Recipient that, from its receive hook, (1) tries to re-enter `withdraw` and swallows the
///      failure, then (2) spends its own funds on `pay(targetId)` — a cross-function re-entry
///      that credits a seller while the outer `withdraw` is still on the stack.
contract PayingReceiver {
    PayGate immutable GATE;
    uint256 public targetId;
    bool public armed;
    uint256 public reentryWithdrawFailures;
    uint256 public nestedPays;

    constructor(PayGate g) { GATE = g; }

    function arm(uint256 id) external {
        targetId = id;
        armed = true;
    }

    function disarm() external { armed = false; }

    function create(uint96 price, uint32 window, string calldata uri) external returns (uint256) {
        return GATE.createResource(price, window, uri);
    }

    function withdraw() external { GATE.withdraw(); }

    receive() external payable {
        if (!armed) return;
        try GATE.withdraw() {} catch { reentryWithdrawFailures++; }
        (uint96 price,,, bool active,) = GATE.quote(targetId);
        if (active && address(this).balance >= price) {
            try GATE.pay{value: price}(targetId, 0) { nestedPays++; } catch {}
        }
    }
}
