// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PayGate} from "../src/PayGate.sol";

/// Deploys PayGate and lists the demo resource (the Polymarket reward-pool screener served by py/server.py).
///
///   forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --private-key $EVM_PRIVATE_KEY
///
/// PAYGATE_DEMO_URL sets the endpoint written into the listing (default: a local py/server.py).
contract Deploy is Script {
    function run() external {
        string memory url = vm.envOr("PAYGATE_DEMO_URL", string("http://127.0.0.1:8402/api/polymarket-rewards"));
        string memory meta = string.concat(
            '{"name":"Polymarket reward pools","desc":"Live screener of Polymarket liquidity-reward pools: USDC per day, minimum size and spread band for every rewarded market.","url":"',
            url,
            '","kind":"dataset"}'
        );
        vm.startBroadcast();
        PayGate gate = new PayGate();
        uint256 id = gate.createResource(0.01 ether, 1 hours, meta); // 0.01 USDC (18-decimal native units) per hour
        vm.stopBroadcast();
        console.log("PayGate:", address(gate));
        console.log("deploy block:", block.number);
        console.log("demo resource id:", id);
    }
}
