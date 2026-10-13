// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PayGate} from "../src/PayGate.sol";

/// Deploys PayGate. Optionally lists the demo resource (the Polymarket reward-pool screener served by py/server.py).
///
///   forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --private-key $EVM_PRIVATE_KEY
///
/// Set PAYGATE_DEMO_URL to also list the demo resource at that endpoint. Leave it unset on mainnet unless a
/// public py/server.py answers there: buyers would pay real USDC for the listing.
contract Deploy is Script {
    function run() external {
        string memory url = vm.envOr("PAYGATE_DEMO_URL", string(""));
        vm.startBroadcast();
        PayGate gate = new PayGate();
        uint256 id;
        if (bytes(url).length > 0) {
            string memory meta = string.concat(
                '{"name":"Polymarket reward pools","desc":"Live screener of Polymarket liquidity-reward pools: USDC per day, minimum size and spread band for every rewarded market.","url":"',
                url,
                '","kind":"dataset"}'
            );
            id = gate.createResource(0.01 ether, 1 hours, meta); // 0.01 USDC (18-decimal native units) per hour
        }
        vm.stopBroadcast();
        console.log("PayGate:", address(gate));
        console.log("deploy block:", block.number);
        if (id != 0) console.log("demo resource id:", id);
    }
}
