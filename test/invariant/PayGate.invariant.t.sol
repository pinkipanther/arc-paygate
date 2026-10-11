// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PayGate} from "../../src/PayGate.sol";
import {PayGateHandler} from "./PayGateHandler.sol";

/// @notice Stateful invariants for PayGate. Only the handler is fuzzed; it uses 6 actors (4 EOAs,
///         a seller whose receive hook reverts, and a receiver that re-enters withdraw and pays
///         from its hook) and at most 8 resources, so random calls collide on the same state.
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = true
contract PayGateInvariantTest is Test {
    PayGate gate;
    PayGateHandler handler;

    function setUp() public {
        vm.warp(1_760_000_000);
        gate = new PayGate();
        handler = new PayGateHandler(gate);
        // Seed one paid and one free resource so early calls hit live state.
        handler.create(0, 1, 1 hours, 8);
        handler.create(1, 0, 1 days, 4);

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = handler.create.selector;
        selectors[1] = handler.update.selector;
        selectors[2] = handler.transfer.selector;
        selectors[3] = handler.pay.selector;
        selectors[4] = handler.payFor.selector;
        selectors[5] = handler.withdraw.selector;
        selectors[6] = handler.withdrawTo.selector;
        selectors[7] = handler.warp.selector;
        selectors[8] = handler.pay.selector; // payments are the hot path: weight them up
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// I-1 Solvency, exact: the gate holds precisely what sellers can withdraw. No wei is stuck or
    ///     created (absent forced sends, which no actor can make here). Also equals the log replay.
    function invariant_balance_equals_sum_of_seller_balances() public view {
        address[] memory a = handler.actors();
        uint256 sum;
        for (uint256 i; i < a.length; ++i) sum += gate.balances(a[i]);
        assertEq(address(gate).balance, sum, "balance != sum(balances)");
        assertEq(address(gate).balance, handler.ghostDeposits() - handler.ghostWithdrawals(), "balance != logs");
        assertEq(gate.balances(handler.SINK()), 0);
        assertEq(gate.balances(address(gate)), 0);
    }

    /// I-2 For every resource, lifetime revenue == sum of `Paid.amount` logged for it.
    function invariant_revenue_equals_sum_of_paid_events() public view {
        uint256 total;
        for (uint256 id = 1; id < gate.nextId(); ++id) {
            uint256 rev = gate.getResource(id).revenue;
            assertEq(rev, handler.ghostPaidSum(id), "revenue != sum(Paid.amount)");
            total += rev;
        }
        assertEq(total, handler.ghostDeposits());
        assertEq(handler.ghostPaidSum(0), 0);
    }

    /// I-3 sales == number of successful pays (counted from logs per id, and from call results
    ///     including pays made inside a withdraw callback).
    function invariant_sales_equals_successful_pays() public view {
        uint256 total;
        for (uint256 id = 1; id < gate.nextId(); ++id) {
            uint256 sales = gate.getResource(id).sales;
            assertEq(sales, handler.ghostPaidCount(id), "sales != count(Paid)");
            total += sales;
        }
        assertEq(total, handler.ghostSuccessfulPays(), "sum(sales) != successful pay calls");
    }

    /// I-4 accessUntil never decreases, for any actor and id (checked after every call), and the
    ///     expiry each payment produces equals the model (paid stacks, free refreshes).
    function invariant_access_never_decreases() public view {
        assertFalse(handler.accessDecreased(), handler.lastViolation());
        assertFalse(handler.untilMismatch(), handler.lastViolation());
        address[] memory a = handler.actors();
        for (uint256 i; i < a.length; ++i) {
            for (uint256 id; id <= gate.nextId(); ++id) {
                uint64 u = gate.accessUntil(a[i], id);
                assertGe(u, handler.lastSeenUntil(a[i], id));
                assertEq(gate.hasAccess(a[i], id), u > block.timestamp);
                assertEq(gate.remaining(a[i], id), u > block.timestamp ? u - block.timestamp : 0);
            }
        }
    }

    /// I-5 Only the current seller can change a resource: on-chain state equals a model that
    ///     only applies seller-authorised updates and transfers.
    function invariant_non_seller_never_changes_resource() public view {
        assertFalse(handler.nonSellerChanged(), handler.lastViolation());
        for (uint256 id = 1; id < gate.nextId(); ++id) {
            PayGate.ResourceView memory v = gate.getResource(id);
            PayGateHandler.Model memory m = handler.model(id);
            assertEq(v.seller, m.seller, "seller");
            assertEq(v.price, m.price, "price");
            assertEq(v.window, m.window, "window");
            assertEq(v.active, m.active, "active");
            assertEq(keccak256(bytes(v.uri)), m.uriHash, "uri");
            assertTrue(v.seller != address(0));
        }
    }

    /// I-6 Every call matched its predicted outcome (exact custom error or success), and every
    ///     successful pay / withdrawal moved exactly the expected amount.
    function invariant_outcomes_match_model() public view {
        assertFalse(handler.unexpectedOutcome(), handler.lastViolation());
        assertFalse(handler.payoutMismatch(), handler.lastViolation());
    }

    /// I-7 Views agree: getResources pages the same records getResource returns; terms stay
    ///     inside the caps.
    function invariant_views_consistent() public view {
        uint256 n = gate.nextId() - 1;
        PayGate.ResourceView[] memory page = gate.getResources(0, type(uint256).max);
        assertEq(page.length, n < gate.MAX_PAGE() ? n : gate.MAX_PAGE());
        for (uint256 i; i < page.length; ++i) {
            assertEq(page[i].id, i + 1);
            assertEq(keccak256(abi.encode(page[i])), keccak256(abi.encode(gate.getResource(i + 1))));
            assertEq(page[i].price % gate.PRICE_UNIT(), 0);
            assertTrue(page[i].window > 0 && page[i].window <= gate.MAX_WINDOW());
            assertLe(bytes(page[i].uri).length, gate.MAX_URI());
        }
        assertEq(gate.getResources(gate.nextId(), 10).length, 0);
    }

    /// The handler really ran: payments happened and money moved through the gate.
    function afterInvariant() external view {
        assertGt(handler.calls(handler.K_PAY()) + handler.calls(handler.K_PAYFOR()), 0);
    }
}
