// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";
import {PayGate} from "../src/PayGate.sol";
import {RevertingReceiver, PayingReceiver} from "./utils/Receivers.sol";

/// @notice v2 feature coverage and regression tests for the audit findings (see AUDIT.md).
contract PayGateV2Test is Test {
    PayGate gate;
    address seller = makeAddr("seller");
    address seller2 = makeAddr("seller2");
    address buyer = makeAddr("buyer");
    address agent = makeAddr("agent");
    address cold = makeAddr("cold");
    uint96 constant PRICE = 0.01 ether; // 0.01 USDC in 18-dec native units
    uint32 constant WINDOW = 1 hours;
    uint96 constant UNIT = 1e12;
    uint96 constant MAX_PRICE = type(uint96).max - type(uint96).max % UNIT;

    function setUp() public {
        gate = new PayGate();
        vm.deal(buyer, 1000 ether);
        vm.deal(agent, 1000 ether);
        vm.prank(seller);
        gate.createResource(PRICE, WINDOW, "https://example.com/api/signals"); // id 1
    }

    function _uri(uint256 len) internal pure returns (string memory) {
        bytes memory b = new bytes(len);
        for (uint256 i; i < len; ++i) b[i] = bytes1(uint8(97 + (i % 26)));
        return string(b);
    }

    function _create(address who, uint96 price, uint32 window) internal returns (uint256 id) {
        vm.prank(who);
        id = gate.createResource(price, window, "r");
    }

    // ================================================================ PG-01 price precision

    function test_price_unit_constant() public view {
        assertEq(gate.PRICE_UNIT(), 1e12);
    }

    /// The classic Arc mistake: a 6-decimal amount (10_000 = 0.01 USDC in ERC-20 units) used as a
    /// native price would sell access for 1e-14 USDC. It is rejected.
    function test_create_rejects_six_decimal_price() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(PayGate.PricePrecision.selector, uint96(10_000)));
        gate.createResource(10_000, WINDOW, "x");
    }

    function test_create_rejects_sub_micro_remainder() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(PayGate.PricePrecision.selector, UNIT + 1));
        gate.createResource(UNIT + 1, WINDOW, "x");
    }

    function test_update_rejects_sub_micro_price() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(PayGate.PricePrecision.selector, uint96(1)));
        gate.updateResource(1, 1, WINDOW, true, "x");
    }

    function test_price_precision_accepts_zero_one_micro_and_max() public {
        uint96 maxPrice = MAX_PRICE;
        vm.startPrank(seller);
        gate.createResource(0, WINDOW, "free");
        gate.createResource(UNIT, WINDOW, "one micro-USDC");
        uint256 id = gate.createResource(maxPrice, WINDOW, "max");
        vm.stopPrank();
        (uint96 p,,,,) = gate.quote(id);
        assertEq(p, maxPrice);
    }

    function testFuzz_price_precision(uint96 price) public {
        vm.prank(seller);
        if (price % UNIT != 0) {
            vm.expectRevert(abi.encodeWithSelector(PayGate.PricePrecision.selector, price));
        }
        gate.createResource(price, WINDOW, "f");
    }

    // ================================================================ PG-04 window cap

    function test_max_window_constant() public view {
        assertEq(gate.MAX_WINDOW(), 365 days);
    }

    function test_create_rejects_window_over_max() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(PayGate.WindowTooLong.selector, uint32(365 days + 1)));
        gate.createResource(PRICE, 365 days + 1, "x");
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(PayGate.WindowTooLong.selector, type(uint32).max));
        gate.createResource(PRICE, type(uint32).max, "x");
    }

    function test_update_rejects_window_over_max() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(PayGate.WindowTooLong.selector, uint32(365 days + 1)));
        gate.updateResource(1, PRICE, 365 days + 1, true, "x");
    }

    function test_window_at_max_ok() public {
        uint256 id = _create(seller, PRICE, 365 days);
        vm.prank(buyer);
        uint64 until = gate.pay{value: PRICE}(id, 365 days);
        assertEq(until, block.timestamp + 365 days);
    }

    function testFuzz_window_bounds(uint32 window) public {
        vm.prank(seller);
        if (window == 0) vm.expectRevert(PayGate.ZeroWindow.selector);
        else if (window > 365 days) vm.expectRevert(abi.encodeWithSelector(PayGate.WindowTooLong.selector, window));
        gate.createResource(PRICE, window, "w");
    }

    // ================================================================ PG-02 free claims refresh

    function test_free_claims_do_not_stack() public {
        uint256 id = _create(seller, 0, 1 days);
        vm.startPrank(buyer);
        uint64 until;
        for (uint256 i; i < 365; ++i) until = gate.pay(id, 0);
        vm.stopPrank();
        assertEq(until, block.timestamp + 1 days);
        assertEq(gate.accessUntil(buyer, id), block.timestamp + 1 days);
        assertEq(gate.getResource(id).sales, 365); // every claim still counts as a sale
    }

    function test_free_claim_refreshes_from_now() public {
        uint256 id = _create(seller, 0, WINDOW);
        vm.prank(buyer);
        gate.pay(id, 0);
        vm.warp(block.timestamp + WINDOW / 2);
        vm.prank(buyer);
        uint64 until = gate.pay(id, 0);
        assertEq(until, block.timestamp + WINDOW);
    }

    function test_free_stockpile_does_not_survive_reprice() public {
        uint256 id = _create(seller, 0, 1 days);
        vm.startPrank(buyer);
        for (uint256 i; i < 30; ++i) gate.pay(id, 0);
        vm.stopPrank();
        vm.prank(seller);
        gate.updateResource(id, PRICE, 1 days, true, "now paid");
        vm.warp(block.timestamp + 1 days);
        assertFalse(gate.hasAccess(buyer, id));
    }

    function test_free_claim_via_payFor_does_not_stack() public {
        uint256 id = _create(seller, 0, WINDOW);
        vm.startPrank(agent);
        for (uint256 i; i < 10; ++i) gate.payFor(id, buyer, 0);
        vm.stopPrank();
        assertEq(gate.accessUntil(buyer, id), block.timestamp + WINDOW);
    }

    /// Making a resource free must not shorten access that was bought (and stacked) earlier.
    function test_free_claim_never_shortens_paid_access() public {
        vm.startPrank(buyer);
        for (uint256 i; i < 5; ++i) gate.pay{value: PRICE}(1, 0);
        vm.stopPrank();
        uint64 paidUntil = gate.accessUntil(buyer, 1);
        assertEq(paidUntil, block.timestamp + 5 * WINDOW);

        vm.prank(seller);
        gate.updateResource(1, 0, WINDOW, true, "now free");
        vm.prank(buyer);
        uint64 until = gate.pay(1, 0);
        assertEq(until, paidUntil);
        assertEq(gate.accessUntil(buyer, 1), paidUntil);
    }

    function test_paid_claims_still_stack_after_free_claim() public {
        uint256 id = _create(seller, 0, WINDOW);
        vm.prank(buyer);
        gate.pay(id, 0);
        vm.prank(seller);
        gate.updateResource(id, PRICE, WINDOW, true, "paid");
        vm.prank(buyer);
        uint64 until = gate.pay{value: PRICE}(id, 0);
        assertEq(until, block.timestamp + 2 * WINDOW);
    }

    /// Any interleaving of free/paid claims and time jumps never moves an expiry backwards.
    function testFuzz_accessUntil_monotonic(uint8[12] calldata ops) public {
        uint64 last;
        for (uint256 i; i < ops.length; ++i) {
            uint8 op = ops[i] % 4;
            if (op == 0) {
                vm.prank(seller);
                gate.updateResource(1, 0, uint32(1 + (ops[i] % 7)) * WINDOW, true, "free");
            } else if (op == 1) {
                vm.prank(seller);
                gate.updateResource(1, PRICE, uint32(1 + (ops[i] % 3)) * WINDOW, true, "paid");
            } else if (op == 2) {
                vm.warp(block.timestamp + uint256(ops[i]) * 97);
            }
            (uint96 p,,,,) = gate.quote(1);
            vm.prank(buyer);
            uint64 until = gate.pay{value: p}(1, 0);
            assertGe(until, last);
            assertGt(until, block.timestamp);
            last = until;
        }
    }

    // ================================================================ PG-03 withdraw ordering

    /// Withdrawn is logged before the external call, so a payment made from the receiver's hook
    /// is logged after it: replaying logs in order reproduces `balances` exactly.
    function test_withdrawn_logged_before_receiver_callback() public {
        PayingReceiver pr = new PayingReceiver(gate);
        vm.deal(address(pr), 1 ether);
        uint256 id = pr.create(PRICE, WINDOW, "self-paying");
        vm.prank(buyer);
        gate.pay{value: PRICE}(id, WINDOW);
        pr.arm(id); // on receive: re-enter withdraw (fails), then buy its own resource again

        vm.recordLogs();
        pr.withdraw();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], PayGate.Withdrawn.selector);
        assertEq(logs[1].topics[0], PayGate.Paid.selector);
        assertEq(pr.reentryWithdrawFailures(), 1);
        assertEq(pr.nestedPays(), 1);
        // Replay: reset-to-zero on Withdrawn, then +PRICE on Paid == on-chain balance.
        assertEq(gate.balances(address(pr)), PRICE);
        assertEq(address(gate).balance, PRICE);
    }

    /// The re-entrant inner withdraw fails, the outer one pays out exactly once.
    function test_withdraw_reentry_pays_once() public {
        PayingReceiver pr = new PayingReceiver(gate);
        uint256 id = pr.create(PRICE, WINDOW, "evil");
        vm.prank(buyer);
        gate.pay{value: PRICE}(id, WINDOW);
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW); // someone else's money in the pool
        pr.arm(999); // target does not exist: only the re-entrant withdraw is attempted

        pr.withdraw();
        assertEq(address(pr).balance, PRICE);
        assertEq(pr.reentryWithdrawFailures(), 1);
        assertEq(gate.balances(address(pr)), 0);
        assertEq(gate.balances(seller), PRICE);
        assertEq(address(gate).balance, PRICE);
    }

    // ================================================================ withdrawTo

    function test_withdrawTo_zero_reverts() public {
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        vm.prank(seller);
        vm.expectRevert(PayGate.ZeroAddress.selector);
        gate.withdrawTo(payable(address(0)));
        assertEq(gate.balances(seller), PRICE);
    }

    function test_withdrawTo_sends_to_recipient_and_emits() public {
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        vm.expectEmit(true, true, true, true, address(gate));
        emit PayGate.Withdrawn(seller, cold, PRICE);
        vm.prank(seller);
        gate.withdrawTo(payable(cold));
        assertEq(cold.balance, PRICE);
        assertEq(seller.balance, 0);
        assertEq(gate.balances(seller), 0);
        assertEq(address(gate).balance, 0);
    }

    function test_withdrawTo_reverting_receiver_keeps_balance() public {
        RevertingReceiver rr = new RevertingReceiver(gate);
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        vm.prank(seller);
        vm.expectRevert(PayGate.TransferFailed.selector);
        gate.withdrawTo(payable(address(rr)));
        assertEq(gate.balances(seller), PRICE);
        assertEq(address(gate).balance, PRICE);
    }

    /// PayGate has no receive/fallback, so pointing a withdrawal at the gate itself fails safely.
    function test_withdrawTo_gate_itself_reverts() public {
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        vm.prank(seller);
        vm.expectRevert(PayGate.TransferFailed.selector);
        gate.withdrawTo(payable(address(gate)));
        assertEq(gate.balances(seller), PRICE);
    }

    function test_withdrawTo_nothing_reverts() public {
        vm.prank(agent);
        vm.expectRevert(PayGate.NothingToWithdraw.selector);
        gate.withdrawTo(payable(agent));
    }

    /// A seller whose own address cannot receive (reverting hook) rescues its revenue.
    function test_rejecting_seller_rescues_funds_with_withdrawTo() public {
        RevertingReceiver rr = new RevertingReceiver(gate);
        uint256 id = rr.create(PRICE, WINDOW);
        vm.prank(buyer);
        gate.pay{value: PRICE}(id, WINDOW);
        vm.expectRevert(PayGate.TransferFailed.selector);
        rr.withdraw();
        rr.withdrawTo(payable(cold));
        assertEq(cold.balance, PRICE);
        assertEq(gate.balances(address(rr)), 0);
    }

    function testFuzz_withdrawTo_only_moves_own_balance(address caller, address to) public {
        vm.assume(caller != seller && to != address(0) && to.code.length == 0 && uint160(to) > 0x10);
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        vm.prank(caller);
        vm.expectRevert(PayGate.NothingToWithdraw.selector);
        gate.withdrawTo(payable(to));
        assertEq(gate.balances(seller), PRICE);
    }

    // ================================================================ transferResource

    function test_transfer_only_seller() public {
        vm.prank(buyer);
        vm.expectRevert(PayGate.NotSeller.selector);
        gate.transferResource(1, buyer);
    }

    function test_transfer_zero_reverts() public {
        vm.prank(seller);
        vm.expectRevert(PayGate.ZeroAddress.selector);
        gate.transferResource(1, address(0));
    }

    function test_transfer_unknown_id_reverts() public {
        vm.prank(seller);
        vm.expectRevert(PayGate.NotSeller.selector);
        gate.transferResource(999, seller2);
    }

    function test_transfer_emits_event() public {
        vm.expectEmit(true, true, true, true, address(gate));
        emit PayGate.ResourceTransferred(1, seller, seller2);
        vm.prank(seller);
        gate.transferResource(1, seller2);
    }

    function test_transfer_then_pay_credits_new_seller_old_keeps_earned() public {
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW); // earned by `seller`
        vm.prank(seller);
        gate.transferResource(1, seller2);
        vm.prank(agent);
        gate.pay{value: PRICE}(1, WINDOW); // earned by `seller2`

        assertEq(gate.balances(seller), PRICE);
        assertEq(gate.balances(seller2), PRICE);
        vm.prank(seller);
        gate.withdraw();
        vm.prank(seller2);
        gate.withdraw();
        assertEq(seller.balance, PRICE);
        assertEq(seller2.balance, PRICE);
        assertEq(address(gate).balance, 0);
    }

    function test_transfer_moves_control() public {
        vm.prank(seller);
        gate.transferResource(1, seller2);
        vm.prank(seller);
        vm.expectRevert(PayGate.NotSeller.selector);
        gate.updateResource(1, PRICE, WINDOW, false, "x");
        vm.prank(seller);
        vm.expectRevert(PayGate.NotSeller.selector);
        gate.transferResource(1, seller);
        vm.prank(seller2);
        gate.updateResource(1, 2 * PRICE, WINDOW, true, "new owner");
        assertEq(gate.getResource(1).price, 2 * PRICE);
        assertEq(gate.getResource(1).seller, seller2);
    }

    /// Lifetime stats and buyers' access belong to the resource, not to the seller.
    function test_transfer_preserves_stats_and_access() public {
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        vm.prank(seller);
        gate.transferResource(1, seller2);
        PayGate.ResourceView memory v = gate.getResource(1);
        assertEq(v.sales, 1);
        assertEq(v.revenue, PRICE);
        assertTrue(gate.hasAccess(buyer, 1));
    }

    function test_transfer_to_self_is_noop() public {
        vm.prank(seller);
        gate.transferResource(1, seller);
        assertEq(gate.getResource(1).seller, seller);
    }

    /// Documented behaviour: a transfer that lands between a buyer's quote and pay routes the
    /// payment to the new seller. The buyer's terms (price, window) are still enforced.
    function test_transfer_between_quote_and_pay_routes_to_new_seller() public {
        (uint96 p, uint32 w, address quotedSeller,,) = gate.quote(1);
        assertEq(quotedSeller, seller);
        vm.prank(seller);
        gate.transferResource(1, seller2);
        vm.prank(buyer);
        gate.pay{value: p}(1, w);
        assertEq(gate.balances(seller2), PRICE);
        assertEq(gate.balances(seller), 0);
        assertTrue(gate.hasAccess(buyer, 1));
    }

    // ================================================================ URI cap

    function test_create_uri_too_long() public {
        string memory u = _uri(513);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(PayGate.UriTooLong.selector, uint256(513)));
        gate.createResource(PRICE, WINDOW, u);
    }

    function test_update_uri_too_long() public {
        string memory u = _uri(513);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(PayGate.UriTooLong.selector, uint256(513)));
        gate.updateResource(1, PRICE, WINDOW, true, u);
    }

    function test_uri_at_cap_and_empty_ok() public {
        string memory u = _uri(512);
        vm.startPrank(seller);
        uint256 id = gate.createResource(PRICE, WINDOW, u);
        assertEq(gate.getResource(id).uri, u);
        gate.updateResource(id, PRICE, WINDOW, true, "");
        assertEq(gate.getResource(id).uri, "");
        gate.updateResource(id, PRICE, WINDOW, true, u);
        assertEq(gate.getResource(id).uri, u);
        vm.stopPrank();
    }

    function testFuzz_uri_cap(uint16 len) public {
        len = uint16(bound(len, 0, 1200));
        string memory u = _uri(len);
        vm.prank(seller);
        if (len > 512) vm.expectRevert(abi.encodeWithSelector(PayGate.UriTooLong.selector, uint256(len)));
        gate.createResource(PRICE, WINDOW, u);
    }

    // ================================================================ remaining()

    function test_remaining_lifecycle() public {
        assertEq(gate.remaining(buyer, 1), 0);
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        assertEq(gate.remaining(buyer, 1), WINDOW);
        vm.warp(block.timestamp + 600);
        assertEq(gate.remaining(buyer, 1), WINDOW - 600);
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        assertEq(gate.remaining(buyer, 1), 2 * WINDOW - 600);
        vm.warp(gate.accessUntil(buyer, 1));
        assertEq(gate.remaining(buyer, 1), 0);
        vm.warp(block.timestamp + 365 days);
        assertEq(gate.remaining(buyer, 1), 0);
    }

    function testFuzz_remaining_matches_hasAccess(uint32 window, uint32 dt) public {
        window = uint32(bound(window, 1, gate.MAX_WINDOW()));
        uint256 id = _create(seller, PRICE, window);
        vm.prank(buyer);
        uint64 until = gate.pay{value: PRICE}(id, 0);
        vm.warp(block.timestamp + dt);
        uint256 rem = gate.remaining(buyer, id);
        assertEq(rem > 0, gate.hasAccess(buyer, id));
        assertEq(rem, until > block.timestamp ? until - block.timestamp : 0);
    }

    // ================================================================ stats / getResource

    function test_getResource_fields_and_stats() public {
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        vm.prank(agent);
        gate.payFor{value: PRICE}(1, buyer, WINDOW);
        PayGate.ResourceView memory v = gate.getResource(1);
        assertEq(v.id, 1);
        assertEq(v.seller, seller);
        assertEq(v.price, PRICE);
        assertEq(v.window, WINDOW);
        assertTrue(v.active);
        assertEq(v.sales, 3);
        assertEq(v.revenue, 3 * PRICE);
        assertEq(v.uri, "https://example.com/api/signals");
    }

    function test_stats_survive_update_and_pause() public {
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        vm.prank(seller);
        gate.updateResource(1, 2 * PRICE, 2 * WINDOW, false, "paused");
        PayGate.ResourceView memory v = gate.getResource(1);
        assertEq(v.sales, 1);
        assertEq(v.revenue, PRICE);
        assertFalse(v.active);
    }

    function test_free_resource_counts_sales_not_revenue() public {
        uint256 id = _create(seller, 0, WINDOW);
        vm.prank(buyer);
        gate.pay(id, 0);
        vm.prank(agent);
        gate.payFor(id, buyer, 0);
        PayGate.ResourceView memory v = gate.getResource(id);
        assertEq(v.sales, 2);
        assertEq(v.revenue, 0);
        assertEq(gate.balances(seller), 0);
    }

    /// The comment in Resource claims slot 0 = seller|price and slot 1 = window|active|sales|revenue.
    function test_storage_packing_matches_comment() public {
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
        bytes32 base = keccak256(abi.encode(uint256(1), uint256(1))); // _resources is slot 1
        uint256 s0 = uint256(vm.load(address(gate), base));
        uint256 s1 = uint256(vm.load(address(gate), bytes32(uint256(base) + 1)));
        assertEq(s0 & type(uint160).max, uint160(seller)); // seller: bytes 0..19
        assertEq(s0 >> 160, PRICE); // price: bytes 20..31
        assertEq(s1 & type(uint32).max, WINDOW); // window: bytes 0..3
        assertEq((s1 >> 32) & 0xff, 1); // active: byte 4
        assertEq((s1 >> 40) & type(uint64).max, 1); // sales: bytes 5..12
        assertEq((s1 >> 104) & type(uint128).max, PRICE); // revenue: bytes 13..28
        assertEq(s1 >> 232, 0); // 29 of 32 bytes used
    }

    // ================================================================ getResources pagination

    function test_getResources_empty_gate() public {
        PayGate fresh = new PayGate();
        assertEq(fresh.getResources(0, 10).length, 0);
        assertEq(fresh.getResources(1, 100).length, 0);
        assertEq(fresh.getResources(1, 0).length, 0);
    }

    function test_getResources_fromId_zero_is_one() public {
        _create(seller, PRICE, WINDOW); // id 2
        PayGate.ResourceView[] memory a = gate.getResources(0, 10);
        PayGate.ResourceView[] memory b = gate.getResources(1, 10);
        assertEq(a.length, 2);
        assertEq(keccak256(abi.encode(a)), keccak256(abi.encode(b)));
        assertEq(a[0].id, 1);
    }

    function test_getResources_past_end_and_limit_zero() public view {
        assertEq(gate.getResources(gate.nextId(), 10).length, 0);
        assertEq(gate.getResources(type(uint256).max, type(uint256).max).length, 0);
        assertEq(gate.getResources(1, 0).length, 0);
        assertEq(gate.getResources(0, 0).length, 0);
    }

    function test_getResources_limit_clamped_to_max_page() public {
        vm.startPrank(seller);
        for (uint256 i; i < 150; ++i) gate.createResource(PRICE, WINDOW, "");
        vm.stopPrank(); // ids 1..151
        assertEq(gate.getResources(1, gate.MAX_PAGE() + 1).length, 100);
        assertEq(gate.getResources(1, type(uint256).max).length, 100);
        PayGate.ResourceView[] memory p = gate.getResources(1, gate.MAX_PAGE());
        assertEq(p.length, 100);
        assertEq(p[99].id, 100);
    }

    function test_getResources_exact_page_boundaries() public {
        vm.startPrank(seller);
        for (uint256 i; i < 249; ++i) gate.createResource(PRICE, WINDOW, "");
        vm.stopPrank(); // ids 1..250, nextId 251
        assertEq(gate.nextId(), 251);

        PayGate.ResourceView[] memory p1 = gate.getResources(1, 100);
        PayGate.ResourceView[] memory p2 = gate.getResources(101, 100);
        PayGate.ResourceView[] memory p3 = gate.getResources(201, 100);
        assertEq(p1.length, 100);
        assertEq(p2.length, 100);
        assertEq(p3.length, 50);
        assertEq(p1[0].id, 1);
        assertEq(p1[99].id, 100);
        assertEq(p2[0].id, 101);
        assertEq(p2[99].id, 200);
        assertEq(p3[0].id, 201);
        assertEq(p3[49].id, 250);
        assertEq(gate.getResources(250, 100).length, 1);
        assertEq(gate.getResources(251, 100).length, 0);
        // web app page size
        assertEq(gate.getResources(226, 25).length, 25);
        assertEq(gate.getResources(226, 25)[24].id, 250);
    }

    function test_getResources_reflects_current_state() public {
        vm.prank(seller);
        gate.updateResource(1, 3 * PRICE, WINDOW, false, "changed");
        PayGate.ResourceView memory v = gate.getResources(1, 1)[0];
        assertEq(v.price, 3 * PRICE);
        assertFalse(v.active);
        assertEq(v.uri, "changed");
    }

    function testFuzz_getResources(uint8 count, uint256 fromId, uint256 limit) public {
        count = uint8(bound(count, 0, 40));
        fromId = bound(fromId, 0, 60);
        limit = bound(limit, 0, 300);
        PayGate g = new PayGate();
        for (uint96 i; i < count; ++i) g.createResource(i * UNIT, WINDOW, "");
        PayGate.ResourceView[] memory out = g.getResources(fromId, limit);

        uint256 start = fromId == 0 ? 1 : fromId;
        uint256 avail = start > count ? 0 : count - start + 1;
        uint256 cap = limit > 100 ? 100 : limit;
        assertEq(out.length, avail < cap ? avail : cap);
        for (uint256 i; i < out.length; ++i) {
            assertEq(out[i].id, start + i);
            assertEq(out[i].price, (start + i - 1) * UNIT);
            assertEq(out[i].seller, address(this));
        }
    }

    // ================================================================ non-existent ids

    function test_nonexistent_ids_in_every_function() public {
        uint256[2] memory ids = [uint256(0), uint256(999)];
        for (uint256 k; k < 2; ++k) {
            uint256 id = ids[k];
            (uint96 p, uint32 w, address s, bool a, string memory u) = gate.quote(id);
            assertEq(p, 0);
            assertEq(w, 0);
            assertEq(s, address(0));
            assertFalse(a);
            assertEq(bytes(u).length, 0);

            PayGate.ResourceView memory v = gate.getResource(id);
            assertEq(v.id, id);
            assertEq(v.seller, address(0));

            vm.prank(buyer);
            vm.expectRevert(PayGate.Inactive.selector);
            gate.pay(id, 0);
            vm.prank(buyer);
            vm.expectRevert(PayGate.Inactive.selector);
            gate.payFor(id, agent, 0);
            vm.prank(seller);
            vm.expectRevert(PayGate.NotSeller.selector);
            gate.updateResource(id, PRICE, WINDOW, true, "squat");
            vm.prank(seller);
            vm.expectRevert(PayGate.NotSeller.selector);
            gate.transferResource(id, seller2);

            assertFalse(gate.hasAccess(buyer, id));
            assertEq(gate.remaining(buyer, id), 0);
            assertEq(gate.accessUntil(buyer, id), 0);
        }
    }

    // ================================================================ events

    function test_events_create_update() public {
        vm.expectEmit(true, true, true, true, address(gate));
        emit PayGate.ResourceCreated(2, seller2, PRICE, WINDOW, "u");
        vm.prank(seller2);
        gate.createResource(PRICE, WINDOW, "u");

        vm.expectEmit(true, true, true, true, address(gate));
        emit PayGate.ResourceUpdated(2, 2 * PRICE, 2 * WINDOW, false, "v");
        vm.prank(seller2);
        gate.updateResource(2, 2 * PRICE, 2 * WINDOW, false, "v");
    }

    function test_event_payFor_distinguishes_payer_and_beneficiary() public {
        vm.expectEmit(true, true, true, true, address(gate));
        emit PayGate.Paid(1, agent, buyer, PRICE, uint64(block.timestamp + WINDOW));
        vm.prank(agent);
        gate.payFor{value: PRICE}(1, buyer, WINDOW);
    }

    // ================================================================ seller powers are bounded

    /// After payment, nothing the seller does shortens or revokes the buyer's access.
    function test_seller_cannot_revoke_paid_access() public {
        vm.prank(buyer);
        uint64 until = gate.pay{value: PRICE}(1, WINDOW);
        vm.startPrank(seller);
        gate.updateResource(1, 0, 1, false, "rug");
        gate.transferResource(1, seller2);
        vm.stopPrank();
        assertEq(gate.accessUntil(buyer, 1), until);
        assertTrue(gate.hasAccess(buyer, 1));
    }

    // ================================================================ arithmetic bounds

    /// Overflow is checked, never silent: a stack that would pass uint64 reverts the payment.
    function test_accessUntil_overflow_reverts_not_wraps() public {
        bytes32 inner = keccak256(abi.encode(buyer, uint256(2))); // accessUntil is slot 2
        bytes32 slot = keccak256(abi.encode(uint256(1), inner));
        vm.store(address(gate), slot, bytes32(uint256(type(uint64).max - 10)));
        vm.prank(buyer);
        vm.expectRevert(stdError.arithmeticError);
        gate.pay{value: PRICE}(1, 0);
    }

    function test_sales_overflow_reverts_not_wraps() public {
        bytes32 base = keccak256(abi.encode(uint256(1), uint256(1)));
        bytes32 s1Slot = bytes32(uint256(base) + 1);
        uint256 s1 = uint256(vm.load(address(gate), s1Slot));
        s1 |= uint256(type(uint64).max) << 40; // sales = max
        vm.store(address(gate), s1Slot, bytes32(s1));
        vm.prank(buyer);
        vm.expectRevert(stdError.arithmeticError);
        gate.pay{value: PRICE}(1, 0);
    }

    function test_max_price_payments_accumulate() public {
        uint96 maxPrice = MAX_PRICE;
        uint256 id = _create(seller, maxPrice, WINDOW);
        vm.deal(buyer, 3 * uint256(maxPrice));
        vm.startPrank(buyer);
        for (uint256 i; i < 3; ++i) gate.pay{value: maxPrice}(id, 0);
        vm.stopPrank();
        assertEq(gate.getResource(id).revenue, 3 * uint256(maxPrice));
        assertEq(gate.balances(seller), 3 * uint256(maxPrice));
    }
}

/// @notice Gas of a full page of the heaviest possible resources, read cold.
contract PayGateFullPageGasTest is Test {
    PayGate gate;

    function setUp() public {
        gate = new PayGate();
        bytes memory b = new bytes(512);
        for (uint256 i; i < 512; ++i) b[i] = bytes1(uint8(0x41 + (i % 26)));
        string memory u = string(b);
        for (uint256 i; i < 100; ++i) gate.createResource(uint96((i + 1) * 1e12), 1 hours, u);
    }

    function test_getResources_full_page_of_max_uris_fits_eth_call_cap() public {
        vm.cool(address(gate)); // every slot cold, like a fresh eth_call
        uint256 g0 = gasleft();
        PayGate.ResourceView[] memory page = gate.getResources(1, 100);
        uint256 used = g0 - gasleft();
        uint256 returndata = abi.encode(page).length;
        emit log_named_uint("getResources(1,100) gas, 100 x 512-byte uris", used);
        emit log_named_uint("returndata bytes", returndata);
        assertEq(page.length, 100);
        assertEq(bytes(page[99].uri).length, 512);
        assertLt(used, 10_000_000); // far below the common 50M eth_call cap
    }

    function test_getResources_web_page_of_25_max_uris() public {
        vm.cool(address(gate));
        uint256 g0 = gasleft();
        PayGate.ResourceView[] memory page = gate.getResources(1, 25);
        uint256 used = g0 - gasleft();
        emit log_named_uint("getResources(1,25) gas, 25 x 512-byte uris", used);
        emit log_named_uint("returndata bytes", abi.encode(page).length);
        assertLt(used, 2_500_000);
    }
}
