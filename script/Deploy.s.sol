// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PayGate} from "../src/PayGate.sol";

/// forge script script/Deploy.s.sol --rpc-url arc --broadcast --private-key $EVM_PRIVATE_KEY
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        PayGate gate = new PayGate();
        // Demo resource: Polymarket liquidity-reward screener, 0.01 USDC per hour of access.
        uint256 id = gate.createResource(0.01 ether, 1 hours, "https://gitlab.com/arg.firefoz/streampay-dashboard/-/tree/arc-paygate");
        vm.stopBroadcast();
        console.log("PayGate:", address(gate));
        console.log("demo resource id:", id);
    }
}
