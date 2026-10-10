# Arc Microgrants submission (DoraHacks) — fill the blanks after deploy

**Project name:** PayGate

**One-liner:** Pay-per-call API access for humans and AI agents, settled in Arc's native USDC: one balance, one transaction, no approve step.

**Live Arc mainnet deployment:** `https://explorer.arc.io/address/<PAYGATE_ADDRESS>` (contract). Web demo: `web/index.html` in the repo, a static page that reads the contract and lets a wallet buy access.

**Public repo:** `https://gitlab.com/arg.firefoz/streampay-dashboard/-/tree/arc-paygate`

**What it does and how it uses Arc**

PayGate is a minimal paywall contract plus an HTTP 402 server. A seller registers a resource with a price and an access window. A buyer, typically an AI agent holding a few cents of USDC, calls `pay(id, minWindow)` with `msg.value = price` and gets a time-boxed entitlement recorded on-chain. The API server answers unauthenticated requests with HTTP 402 and payment instructions, then serves the resource once the caller proves control of a paid address (EIP-191 signature bound to chain id, contract and resource id) and `hasAccess` returns true.

This only works cleanly on Arc. On other EVM chains an agent needs two assets (gas plus a stablecoin) and two transactions (approve plus transfer) before it can buy anything, which is why most "agent payments" designs end up with off-chain balances and custodial accounts. On Arc the gas token is USDC, so a value transfer is a dollar payment: PayGate's `pay` is `payable`, prices are in native USDC, sellers withdraw native USDC, and the first payment from a fresh agent key costs about 74k gas, roughly 0.0015 USDC at the 20 gwei floor.

Buyer protections are on-chain: exact-amount enforcement, and a `minWindow` guard so a seller cannot shorten the window between the quote and the payment. The reference client treats the 402 body as untrusted: it re-reads the quote from the contract, builds calldata locally, pins the chain and contract, and caps spend.

**Demo resource:** a live screener of Polymarket liquidity-reward pools (USDC per day, minimum order size, spread band), a dataset a trading agent would actually pay for.

**Status:** 29 Foundry tests (fuzz, front-running, re-entrancy, overflow), an anvil-backed end-to-end suite that drives the real server and client through 402 → pay → 200 plus hostile-server cases, CI workflow, MIT license.

**Builder profile:** `https://gitlab.com/arg.firefoz` (or X / Farcaster)

**Not previously funded** by a Circle or Arc program. Not a design mockup; deployed and callable on Arc mainnet.
