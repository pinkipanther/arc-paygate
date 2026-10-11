// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PayGate} from "../src/PayGate.sol";

/// @notice One state-changing call per test, so `.gas-snapshot` tracks each hot path on its own.
///         Snapshot: forge snapshot --no-match-test "testFuzz|invariant"
contract PayGateGasTest is Test {
    PayGate gate;
    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");
    address buyer2 = makeAddr("buyer2");
    uint96 constant PRICE = 0.01 ether;
    uint32 constant WINDOW = 1 hours;
    string constant URI = "https://example.com/api/signals";

    function setUp() public {
        gate = new PayGate();
        vm.deal(buyer, 1 ether);
        vm.deal(buyer2, 1 ether);
        vm.prank(seller);
        gate.createResource(PRICE, WINDOW, URI); // id 1
        vm.prank(seller);
        gate.createResource(0, WINDOW, "free"); // id 2
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW); // seller balance and buyer access now non-zero
    }

    function test_gas_createResource() public {
        vm.prank(seller);
        gate.createResource(PRICE, WINDOW, URI);
    }

    function test_gas_pay_first() public {
        vm.prank(buyer2);
        gate.pay{value: PRICE}(1, WINDOW);
    }

    function test_gas_pay_repeat() public {
        vm.prank(buyer);
        gate.pay{value: PRICE}(1, WINDOW);
    }

    function test_gas_payFor() public {
        vm.prank(buyer);
        gate.payFor{value: PRICE}(1, buyer2, WINDOW);
    }

    function test_gas_pay_free_claim() public {
        vm.prank(buyer2);
        gate.pay(2, 0);
    }

    function test_gas_updateResource() public {
        vm.prank(seller);
        gate.updateResource(1, 2 * PRICE, WINDOW, true, URI);
    }

    function test_gas_transferResource() public {
        vm.prank(seller);
        gate.transferResource(1, buyer2);
    }

    function test_gas_withdraw() public {
        vm.prank(seller);
        gate.withdraw();
    }

    function test_gas_withdrawTo() public {
        vm.prank(seller);
        gate.withdrawTo(payable(buyer2));
    }
}
