# PayGate — pay-per-call APIs settled in Arc's native USDC

**What it is.** A tiny paywall for HTTP resources where the buyer (a person or an AI agent) pays with a
plain value transfer on [Arc](https://docs.arc.io) and the server checks access on-chain. Because Arc's
gas token *is* USDC, there is no `approve` step, no wrapped token, and no separate gas asset: an agent
holding a few cents of USDC can pay 0.01 USDC for an hour of API access in one transaction whose gas
costs ~0.0015 USDC (≈74k gas at the 20 gwei floor).

**Why Arc.** On every other EVM chain an agent needs two assets (gas + stablecoin) and two transactions
(approve + pay) before it can buy anything. On Arc it needs one balance and one call. PayGate is built
around that property: `pay(id, minWindow)` is `payable`, the price is denominated in native USDC
(18-dec wei), and sellers withdraw native USDC.

## Contract

`src/PayGate.sol` (Solidity 0.8.26, no dependencies, no owner, no upgradeability, no admin keys)

| Function | Who | Does |
|---|---|---|
| `createResource(price, window, uri)` | seller | registers a resource; `window` seconds of access per payment |
| `updateResource(id, price, window, active, uri)` | seller | reprice / resize / pause; never revokes access already paid for |
| `pay(id, minWindow)` payable | buyer | pays exactly `price`; reverts unless the window is still ≥ `minWindow`; access stacks on top of any remaining time |
| `payFor(id, beneficiary, minWindow)` payable | anyone | fund another address's access (an operator topping up its agent's key) |
| `hasAccess(who, id)` view | server | the only check a gated server needs |
| `quote(id)` view | server | fields for a 402 response |
| `withdraw()` | seller | pull accumulated USDC (checks-effects-interactions) |

Events: `ResourceCreated`, `ResourceUpdated`, `Paid`, `Withdrawn`.

Buyer protections are enforced on-chain, so a seller cannot change the deal between the 402 and the
payment: the amount must equal the current price exactly (`WrongAmount`), and the window must be at least
what the buyer was quoted (`WindowTooShort`). Expiry is a `uint64` extended by a `uint32` window with
checked arithmetic, so stacking cannot overflow at any realistic timestamp.

29 Foundry tests (`forge test`), including fuzz tests on exact-amount and min-window enforcement,
seller front-running of price and window, re-entrant and reverting sellers on `withdraw`, and max-window
stacking.

## HTTP flow (x402-style)

```
GET /api/polymarket-rewards
  -> 402 {"scheme":"paygate-native-v1","chain_id":5042,"contract":"0x..","resource_id":1,
          "price_wei":"10000000000000000","price_usdc":"0.01","window_seconds":3600,
          "pay_calldata":"0x..","auth":{"nonce":N,"message":"paygate:5042:0x<contract>:1:N"}}
client: reads quote(1) from the contract, checks it against the 402, sends pay(1, 3600) with value=price
client: signs "paygate:5042:0x<contract>:1:N" (EIP-191 personal_sign)
GET /api/polymarket-rewards  X-PayGate-Address: 0x..  X-PayGate-Signature: 0x..
  -> 200 {"access_until": 1760140000, "data": {...}}
```

The signature proves control of the paying address; the server never holds keys and never sees a
payment off-chain. The signed message is bound to the chain id, contract address and resource id, so it
cannot be replayed against a different PayGate deployment. `nonce = floor(unix/300)`: a signature is a
bearer token for 5–10 minutes (the previous bucket is accepted to cover the boundary). Access is
read-only, so a replayed signature can only re-read data the signer already paid for — but serve the
API over TLS so signatures are not sniffable in the first place. Responses carry `Cache-Control: no-store`.

**The client treats the 402 body as untrusted.** `py/client.py` only pays on its configured chain
(`PAYGATE_CHAIN_ID`), optionally only to a pinned contract (`PAYGATE_ADDR`), re-reads the price and window
from the contract and refuses if the server's numbers differ, builds the `pay` calldata locally (it never
sends server-supplied calldata), caps spend with `PAYGATE_MAX_WEI` (default 0.1 USDC), and only signs the
fixed-format `paygate:` message it reconstructs itself. A 401 or 5xx after signing never triggers a
payment; only a 402 that reports "no active access" does.

Demo resource: a live screener of Polymarket liquidity-reward pools (USDC/day, min size, spread band),
i.e. a real dataset a trading agent would pay for.

## Run

```bash
forge test
# deploy (~0.97M gas ≈ 0.02 USDC at the 20 gwei floor)
forge script script/Deploy.s.sol --rpc-url arc --broadcast --private-key $EVM_PRIVATE_KEY
# serve (fails fast if the RPC chain id, contract code or demo resource don't check out)
PAYGATE_ADDR=0x... python py/server.py
# buy as an agent
EVM_PRIVATE_KEY=0x... PAYGATE_ADDR=0x... python py/client.py http://localhost:8402/api/polymarket-rewards
# end-to-end test of the 402 flow on a local anvil chain (needs `forge build` first)
cd py && python -m unittest -v test_e2e
```

Python deps: `web3>=7`, `eth-account`, `httpx`.

Server env: `PAYGATE_ADDR` (required), `PAYGATE_RPC`, `PAYGATE_CHAIN_ID` (5042), `PAYGATE_DEMO_ID` (1),
`PAYGATE_SELLER` (optional: refuse to start unless the demo resource belongs to this address — guards
against a resource-id mix-up since ids are sequential), `PORT` (8402).

## Deployment

| Network | Chain ID | RPC | PayGate | Demo resource |
|---|---|---|---|---|
| Arc mainnet | 5042 | `https://rpc.mainnet.arc.io` | _pending_ | id 1, 0.01 USDC / hour |
| Arc testnet | 5042002 | `https://rpc.testnet.arc.io` | _pending_ | — |

## Notes

- Native USDC on Arc has 18 decimals in `msg.value`; the ERC-20 view has 6. Prices here are in wei.
- `window` stacking: paying while access is still valid extends from the current expiry, so prepaying is safe.
- Pausing a resource (`active = false`) stops new sales; already-granted access keeps working until it expires.
- Pull-pattern withdrawals; a seller whose receive hook reverts keeps their balance and can retry later.
- Stray value transfers to the contract revert (no `receive`), so funds can only enter through `pay`/`payFor`.

## License

MIT — see `LICENSE`.

## Web demo

`docs/index.html` is a static page served at https://argenestel.github.io/arc-paygate/ . It reads the live contract (quote, seller balance, recent `Paid` events), shows gas per payment from the current base fee, and lets an injected wallet buy an hour of the demo resource on Arc.
