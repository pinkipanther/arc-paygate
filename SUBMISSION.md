# Arc Microgrants submission (DoraHacks)

Deployed on Arc mainnet on 2026-10-13: contract `0xf7Ba31bb3aAC44b43ba36Ee873C56c4b80915b4d`, block 25704030, deploy tx `0x3ad8f2496f2e41f49fa18ed5cf12cfed434d1e32a1cd9c1be3e87c2a5ca60772`.

**Project name:** PayGate

**One-liner:** Sell API access by the hour for native USDC on Arc. Buyers, including AI agents, pay in one transaction with nothing to approve.

**Live Arc mainnet deployment:** https://explorer.arc.io/address/0xf7Ba31bb3aAC44b43ba36Ee873C56c4b80915b4d

**Web app:** https://arc-paygate.vercel.app — marketplace, buy flow with a live access pass, seller console (list, reprice, pause, transfer, withdraw), on-chain activity feed and an integration guide.

**Public repo:** https://github.com/pinkipanther/arc-paygate

**What it does and how it uses Arc**

PayGate is a paywall contract, an HTTP 402 server and a web app. A seller lists an endpoint with a price and an access window. A buyer calls `pay(id, minWindow)` with `msg.value = price` and receives a time-boxed pass recorded on-chain. The seller's server answers unpaid requests with HTTP 402 and serves the resource once the caller proves, with a signature bound to the chain, contract, resource and host, that they hold a valid pass.

This design depends on Arc. Elsewhere an agent needs two assets (gas plus a stablecoin) and two transactions (approve plus transfer) before it can buy anything, which is why most agent-payment designs fall back to custodial balances. On Arc the gas token is USDC, so `pay` is `payable`, prices are native USDC, sellers withdraw native USDC, and a first purchase from a fresh agent key is one transaction of about 61,000 gas, a fraction of a cent of USDC at Arc's fee levels.

**Safety work:** independent contract reviews (lead audit with invariant tests, plus a second independent review), a server and client security review, and an adversarial protocol review. Findings and their status are in `AUDIT.md` and `py/SECURITY.md`. The contract has no owner, no fees and no upgrade path.

**Builder profile:** https://github.com/pinkipanther

**Not previously funded** by a Circle or Arc program.
