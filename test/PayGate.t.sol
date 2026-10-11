// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PayGate} from "../src/PayGate.sol";

/// @dev Seller that tries to re-enter `withdraw` from its receive hook.
contract ReentrantSeller {
    PayGate immutable gate;
    uint256 public entered;

    constructor(PayGate g) { gate = g; }

    function create(uint96 price, uint32 window) external returns (uint256) {
        return gate.createResource(price, window, "evil");
    }

    function withdraw() external { gate.withdraw(); }

    receive() external payable {
        entered++;
        if (entered < 3) gate.withdraw(); // reverts NothingToWithdraw -> bubbles as TransferFailed
    }
}

/// @dev Seller whose receive hook always reverts (e.g. a misconfigured multisig).
contract RejectingSeller {
    PayGate immutable gate;

    constructor(PayGate g) { gate = g; }

    function create(uint96 price, uint32 window) external returns (uint256) {
        return gate.createResource(price, window, "reject");
    }

    function withdraw() external { gate.withdraw(); }

    receive() external payable { revert("no"); }
}

contract PayGateTest is Test {
    PayGate gate;
    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");
    address agent = makeAddr("agent");
    uint96 constant PRICE = 0.01 ether; // 0.01 USDC in 18-dec native units
    uint32 constant WINDOW = 1 hours;

    function setUp() public {
        gate = new PayGate();
        vm.deal(buyer, 1 ether);
        vm.prank(seller);
        gate.createResource(PRICE, WINDOW, "https://example.com/api/signals");
    }

    // ---------------------------------------------------------------- create / update

    function test_create_sets_fields() public view {
        (uint96 p, uint32 w, address s, bool a, string memory u) = gate.quote(1);
        assertEq(p, PRICE); assertEq(w, WINDOW); assertEq(s, seller); assertTrue(a);
        assertEq(u, "https://example.com/api/signals");
        assertEq(gate.nextId(), 2);
    }

    function test_create_rejects_zero_window() public {
        vm.expectRevert(PayGate.ZeroWindow.selector);
        gate.createResource(PRICE, 0, "x");
    }

    function test_update_only_seller() public {
        vm.prank(buyer);
        vm.expectRevert(PayGate.NotSeller.selector);
        gate.updateResource(1, 1, 1, true, "x");
    }

    function test_update_rejects_zero_window() public {
        vm.prank(seller);
        vm.expectRevert(PayGate.ZeroWindow.selector);
        gate.updateResource(1, PRICE, 0, true, "x");
    }

    function test_quote_unknown_id_is_inactive() public view {
        (uint96 p, uint32 w, address s, bool a,) = gate.quote(999);
        assertEq(p, 0); assertEq(w, 0); assertEq(s, address(0)); assertFalse(a);
        assertFalse(gate.hasAccess(buyer, 999));
    }

    // ---------------------------------------------------------------- pay

    function test_pay_grants_window() public {
        vm.prank(buyer);
        uint64 until = gate.pay{value: PRICE}(1, WINDOW);
        assertEq(until, block.timestamp + WINDOW);
        assertTrue(gate.hasAccess(buyer, 1));
        assertEq(gate.balances(seller), PRICE);
        vm.warp(until - 1);
        assertTrue(gate.hasAccess(buyer, 1)); // last second of the window
        assertEq(gate.remaining(buyer, 1), 1);
        vm.warp(until);
        assertFalse(gate.hasAccess(buyer, 1)); // exactly WINDOW seconds, then closed
        assertEq(gate.remaining(buyer, 1), 0);
    }

    function test_pay_stacks_windows() public {
        vm.startPrank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        uint64 until = gate.pay{value: PRICE}(1, WINDOW);
        vm.stopPrank();
        assertEq(until, block.timestamp + 2 * WINDOW);
    }

    function test_pay_after_expiry_restarts_from_now() public {
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        vm.warp(block.timestamp + 10 days);
        vm.prank(buyer);
        uint64 until = gate.pay{value: PRICE}(1, WINDOW);
        assertEq(until, block.timestamp + WINDOW);
    }

    function test_pay_wrong_amount_reverts() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(PayGate.WrongAmount.selector, PRICE, PRICE - 1));
        gate.pay{value: PRICE - 1}(1, WINDOW);
    }

    function test_pay_inactive_reverts() public {
        vm.prank(seller);
        gate.updateResource(1, PRICE, WINDOW, false, "x");
        vm.prank(buyer);
        vm.expectRevert(PayGate.Inactive.selector);
        gate.pay{value: PRICE}(1, WINDOW);
    }

    function test_pay_unknown_id_reverts_inactive() public {
        vm.prank(buyer);
        vm.expectRevert(PayGate.Inactive.selector);
        gate.pay{value: 0}(999, 0);
    }

    /// Seller front-runs a buyer's `pay` with a price change: exact-amount check rejects it,
    /// so the buyer never overpays and never pays a raised price unknowingly.
    function test_pay_reverts_when_seller_frontruns_price() public {
        vm.prank(seller);
        gate.updateResource(1, PRICE * 2, WINDOW, true, "x");
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(PayGate.WrongAmount.selector, PRICE * 2, PRICE));
        gate.pay{value: PRICE}(1, WINDOW);

        vm.prank(seller);
        gate.updateResource(1, PRICE / 2, WINDOW, true, "x");
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(PayGate.WrongAmount.selector, PRICE / 2, PRICE));
        gate.pay{value: PRICE}(1, WINDOW);
    }

    /// Seller front-runs a buyer's `pay` by shrinking the window: `minWindow` rejects it.
    function test_pay_reverts_when_seller_frontruns_window() public {
        vm.prank(seller);
        gate.updateResource(1, PRICE, 1, true, "x");
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(PayGate.WindowTooShort.selector, WINDOW, uint32(1)));
        gate.pay{value: PRICE}(1, WINDOW);
        assertEq(gate.balances(seller), 0);
    }

    function test_pay_minWindow_zero_accepts_any_window() public {
        vm.prank(seller);
        gate.updateResource(1, PRICE, 1, true, "x");
        vm.prank(buyer);
        uint64 until = gate.pay{value: PRICE}(1, 0);
        assertEq(until, block.timestamp + 1);
    }

    function test_pay_accepts_window_longer_than_min() public {
        vm.prank(seller);
        gate.updateResource(1, PRICE, 2 * WINDOW, true, "x");
        vm.prank(buyer);
        uint64 until = gate.pay{value: PRICE}(1, WINDOW);
        assertEq(until, block.timestamp + 2 * WINDOW);
    }

    /// uint64 expiry + uint32 window cannot overflow at realistic timestamps even with the
    /// maximum window (~136 years) stacked repeatedly.
    function test_pay_max_window_stacks_without_overflow() public {
        vm.prank(seller);
        uint256 id = gate.createResource(0, type(uint32).max, "max");
        vm.warp(4_000_000_000); // year 2096
        vm.startPrank(buyer);
        uint64 until;
        for (uint256 i = 0; i < 5; i++) until = gate.pay(id, type(uint32).max);
        vm.stopPrank();
        assertEq(until, uint64(block.timestamp) + 5 * uint64(type(uint32).max));
        assertTrue(gate.hasAccess(buyer, id));
    }

    function test_deactivate_keeps_already_paid_access() public {
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        vm.prank(seller);
        gate.updateResource(1, PRICE, WINDOW, false, "x");
        assertTrue(gate.hasAccess(buyer, 1));
    }

    function test_free_resource_records_access_without_balance() public {
        vm.prank(seller);
        uint256 id = gate.createResource(0, WINDOW, "free");
        vm.prank(buyer);
        gate.pay{value: 0}(id, WINDOW);
        assertTrue(gate.hasAccess(buyer, id));
        assertEq(gate.balances(seller), 0);
    }

    function test_pay_emits_event() public {
        vm.prank(buyer);
        vm.expectEmit(true, true, true, true);
        emit PayGate.Paid(1, buyer, buyer, PRICE, uint64(block.timestamp + WINDOW));
        gate.pay{value: PRICE}(1, WINDOW);
    }

    // ---------------------------------------------------------------- payFor

    function test_payFor_grants_beneficiary_not_payer() public {
        vm.prank(buyer);
        gate.payFor{value: PRICE}(1, agent, WINDOW);
        assertTrue(gate.hasAccess(agent, 1));
        assertFalse(gate.hasAccess(buyer, 1));
        assertEq(gate.balances(seller), PRICE);
    }

    function test_payFor_zero_beneficiary_reverts() public {
        vm.prank(buyer);
        vm.expectRevert(PayGate.ZeroAddress.selector);
        gate.payFor{value: PRICE}(1, address(0), WINDOW);
    }

    // ---------------------------------------------------------------- withdraw

    function test_withdraw_pull_pattern() public {
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        uint256 before = seller.balance;
        vm.prank(seller);
        gate.withdraw();
        assertEq(seller.balance - before, PRICE);
        assertEq(gate.balances(seller), 0);
        vm.prank(seller);
        vm.expectRevert(PayGate.NothingToWithdraw.selector);
        gate.withdraw();
    }

    function test_withdraw_isolated_per_seller() public {
        address seller2 = makeAddr("seller2");
        vm.prank(seller2);
        uint256 id2 = gate.createResource(PRICE, WINDOW, "two");
        vm.startPrank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        gate.pay{value: PRICE}(id2, WINDOW);
        vm.stopPrank();
        vm.prank(seller);
        gate.withdraw();
        assertEq(gate.balances(seller2), PRICE);
        assertEq(address(gate).balance, PRICE);
    }

    function test_withdraw_reentrancy_cannot_drain() public {
        ReentrantSeller evil = new ReentrantSeller(gate);
        uint256 id = evil.create(PRICE, WINDOW);
        // Two buyers fund the pool so there is more in the contract than evil's balance.
        vm.deal(agent, 1 ether);
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);     // belongs to `seller`
        vm.prank(agent);
        gate.pay{value: PRICE}(id, WINDOW);    // belongs to `evil`
        assertEq(address(gate).balance, 2 * PRICE);

        // Inner re-entrant withdraw reverts (balance already zero) -> receive reverts ->
        // outer call fails -> whole withdraw reverts. Nothing moves.
        vm.expectRevert(PayGate.TransferFailed.selector);
        evil.withdraw();
        assertEq(address(gate).balance, 2 * PRICE);
        assertEq(gate.balances(address(evil)), PRICE);
        assertEq(gate.balances(seller), PRICE);
    }

    function test_withdraw_rejecting_receiver_keeps_balance() public {
        RejectingSeller rs = new RejectingSeller(gate);
        uint256 id = rs.create(PRICE, WINDOW);
        vm.prank(buyer);
        gate.pay{value: PRICE}(id, WINDOW);
        vm.expectRevert(PayGate.TransferFailed.selector);
        rs.withdraw();
        assertEq(gate.balances(address(rs)), PRICE);
    }

    function test_stray_value_transfer_reverts() public {
        vm.prank(buyer);
        (bool ok,) = address(gate).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(gate).balance, 0);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_pay_exact_amount_only(uint96 price, uint256 sent) public {
        vm.assume(sent < 1 ether && price < 1 ether);
        vm.prank(seller);
        uint256 id = gate.createResource(price, WINDOW, "f");
        vm.prank(buyer);
        if (sent != price) vm.expectRevert(abi.encodeWithSelector(PayGate.WrongAmount.selector, price, sent));
        gate.pay{value: sent}(id, WINDOW);
    }

    function testFuzz_pay_minWindow_guard(uint32 window, uint32 minWindow) public {
        vm.assume(window > 0);
        vm.prank(seller);
        uint256 id = gate.createResource(PRICE, window, "f");
        vm.prank(buyer);
        if (window < minWindow) {
            vm.expectRevert(abi.encodeWithSelector(PayGate.WindowTooShort.selector, minWindow, window));
        }
        gate.pay{value: PRICE}(id, minWindow);
    }

    function testFuzz_stacking_never_shortens_access(uint8 n) public {
        vm.assume(n > 0 && n < 20);
        vm.deal(buyer, uint256(n) * PRICE);
        vm.startPrank(buyer);
        uint64 last;
        for (uint256 i = 0; i < n; i++) {
            uint64 until = gate.pay{value: PRICE}(1, WINDOW);
            assertGt(until, last);
            last = until;
        }
        vm.stopPrank();
        assertEq(last, block.timestamp + uint256(n) * WINDOW);
        assertEq(gate.balances(seller), uint256(n) * PRICE);
    }
}
