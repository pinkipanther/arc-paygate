# PayGate

Sell access to an API by the hour, paid in native USDC on [Arc](https://docs.arc.io).

A seller lists an endpoint with a price and an access window. A buyer, usually an AI agent, makes one
`pay()` call and holds a time-boxed pass on-chain. The seller's server answers unpaid requests with
HTTP 402 and serves paid ones after one view call, `hasAccess(buyer, id)`.

- **Web app:** https://argenestel.github.io/arc-paygate/ (marketplace, buy flow, seller console, activity, integration guide)
- **Contract:** `src/PayGate.sol`, no owner, no fees, no upgradeability
- **402 server and agent client:** `py/`
- **Audit:** [`AUDIT.md`](AUDIT.md) (contract) and [`py/SECURITY.md`](py/SECURITY.md) (server and client)

## Why Arc

Arc's gas token is USDC, so a plain value transfer is a dollar payment.

| | Typical EVM chain | Arc with PayGate |
|---|---|---|
| Assets the buyer holds | a stablecoin plus ETH for gas | USDC only |
| Transactions for a first purchase | `approve`, then transfer | one `pay()` |
| Gas paid in | a volatile token | USDC |
| Custody until withdrawal | often a facilitator | the contract |

## What a pass is, and isn't

A pass is an on-chain entitlement for `(address, resource)` that lasts a fixed window. It is
**pay-per-access**, not pay-per-call: the seller's server decides how many calls a window allows.

- Paying again while a pass is active extends it. Free (price 0) passes don't stack.
- There are no refunds and no delivery guarantee. Serving the data is the seller's job.
- Anyone holding the buyer's key can use the pass.
- `sales` and `revenue` are recorded on-chain, but a seller can buy their own pass, so they show activity, not reputation.

## Contract

`src/PayGate.sol`, Solidity 0.8.26, no dependencies.

| Function | Who | Does |
|---|---|---|
| `createResource(price, window, uri)` | seller | List a resource. Window 1 second to 365 days; price in 18-decimal native units, at most 6 decimals of USDC. |
| `updateResource(id, price, window, active, uri)` | seller | Reprice, resize, pause or edit. Never revokes passes already sold. |
| `transferResource(id, to)` | seller | Hand future sales to another address. Earned balance stays with the old seller. |
| `pay(id, minWindow)` payable | buyer | Pay exactly `price`. Reverts if the window is now shorter than `minWindow`. |
| `payFor(id, beneficiary, minWindow)` payable | anyone | Same, for another address (e.g. an agent's key). |
| `withdraw()` / `withdrawTo(to)` | seller | Pull accumulated USDC. |
| `hasAccess(who, id)` view | server | True while the pass is valid. Expiry is exclusive: a window of `w` grants exactly `w` seconds. |
| `remaining(who, id)` view | anyone | Seconds left on a pass. |
| `quote(id)` view | anyone | Price, window, seller, on-sale flag, uri. |
| `getResource(id)`, `getResources(from, limit)` views | frontends | Full records including sales and revenue; page with `limit <= 25`. |

Events: `ResourceCreated`, `ResourceUpdated`, `ResourceTransferred`, `Paid`, `Withdrawn`.

**Buyer protection.** The amount must equal the current price (`WrongAmount`) and the window must be at
least what the buyer was quoted (`WindowTooShort`), so a seller can't charge more or deliver less than
the quote. A seller *can* change terms right before a purchase; the buyer's transaction then reverts
and costs gas (about 61k gas, a fraction of a cent of USDC). A price cut also reverts; the buyer re-reads the quote and pays again.

**Listing metadata.** `uri` (max 512 bytes) is either a URL or a compact JSON object
`{"name","desc","url","kind"}`. The web app writes the JSON form.

## HTTP flow

```
GET /api/data                               → 402 with chain, contract, resource id, price, window, nonce
client reads quote(id) on-chain, checks it  → pay(id, window) with value = price      (one Arc tx)
client signs paygate:2:<chain>:<contract>:<id>:<nonce>:<host>   (EIP-191)
GET /api/data + X-PayGate-Address, X-PayGate-Signature           → 200
```

The signed message is bound to the chain, contract, resource, a five-minute time bucket and the
server's host, so a signature collected by one server can't be replayed at another. Within its bucket
a signature works as a bearer credential; serve the API over TLS.

The 402 also carries an x402-shaped `accepts` envelope with the scheme name `exact-native`, so
x402-aware agents can parse the offer. Payment is a native `pay()` call, not an EIP-3009
authorization; this is not a registered x402 scheme.

Servers publish a discovery document at `/.well-known/paygate.json` (chain, contract, message format,
resources for sale). Browsers on the allowed origins (`PAYGATE_CORS_ORIGINS`) can call the API directly,
which is how the web app's "Use your pass" panel works.

`PAYGATE_PUBLIC_HOST` is required in production: it is the host signatures must be bound to.
Other settings (rate limits, connection caps, trusted proxies, JSON logs) are listed at the top of
`py/server.py`.

The reference client in `py/client.py` treats the 402 body as untrusted: it pins the contract,
re-reads the terms on-chain, builds the transaction itself, caps spend and never signs server-supplied
text. Details in [`py/SECURITY.md`](py/SECURITY.md).

## Run it

```bash
forge test                                   # unit, fuzz and invariant tests
cd py && python -m unittest -v test_e2e      # 402 → pay → 200 on a local anvil chain

# deploy + demo listing (≈2.1M gas, about 0.04 USDC at Arc's 20 gwei floor)
forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --private-key $EVM_PRIVATE_KEY

# serve (behind a TLS reverse proxy in production)
PAYGATE_ADDR=0x… PAYGATE_PUBLIC_HOST=api.example.com PAYGATE_SELLER=0x… python py/server.py --json

# buy as an agent (key from EVM_PRIVATE_KEY or --key-file, never an argument)
python py/client.py discover https://api.example.com
python py/client.py fetch https://api.example.com/api/polymarket-rewards --contract 0x… --max-usdc 0.05

# web app
cd app && npm install && npm run dev        # or `npm run build` to regenerate docs/
```

## Deployment

| Network | Chain ID | PayGate |
|---|---|---|
| Arc testnet | 5042002 | pending (faucet) |
| Arc mainnet | 5042 | pending |

Addresses are set in `app/.env.production` and baked into the web app at build time.

## License

MIT, see `LICENSE`.
