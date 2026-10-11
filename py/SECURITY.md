# PayGate Python server and client: security notes

Scope: `py/server.py` (the HTTP 402 gate) and `py/client.py` (the reference buyer), protocol
**`paygate-native-v2`**. The Solidity contract is covered by the Foundry suite in `test/`; this
document only relies on its documented semantics (`remaining()`/`hasAccess` are exclusive at
expiry, `hasAccess` ignores `active`, `pay(id, minWindow)` enforces the exact price and a minimum
window).

## Protocol reference

**Signed message** (EIP-191 `personal_sign`, the only text a buyer ever signs):

```
paygate:2:<chain_id>:<contract_lowercase>:<resource_id>:<nonce>:<host_lowercase>
```

- `nonce = floor(unix_seconds / 300)`. The server accepts the current and the previous bucket, so a
  signature works for 5 to 10 minutes. The client never signs a bucket later than its own clock.
- `host` is the host of the URL the client requested: lowercase, IDNA/punycode for unicode names,
  IPv6 in brackets, plus `:port` only when it is not the scheme default (443 for https, 80 for
  http). Examples: `api.example.com`, `api.example.com:8443`, `127.0.0.1:8402`.
- The server binds `host` to `PAYGATE_PUBLIC_HOST` and ignores the `Host` header when that is
  set, since proxies rewrite it. When it is not set, only a loopback `Host` for the server's own
  port is accepted (local development). Any other `Host` gets **421** and no signature is
  verified against it.

**Proof headers.** Send either:
- `X-PayGate-Address: 0x…` and `X-PayGate-Signature: 0x…` (65-byte signature, hex), or
- `X-PAYMENT: base64(JSON)` with
  `{"x402Version":1,"scheme":"exact-native","network":"eip155:<chain>","payload":{"from":"0x…","signature":"0x…","nonce":N}}`.

Sending both is a 400. On a 200 the server adds
`X-PAYMENT-RESPONSE: base64({"success":true,"network":"eip155:<chain>","payer":"0x…","accessUntil":T})`.

**402 body** (an x402-style envelope plus the PayGate fields the client verifies; no calldata):

```json
{
  "x402Version": 1, "error": "PAYMENT_REQUIRED", "reason": "payment required | no active access for this address",
  "accepts": [{"scheme": "exact-native", "network": "eip155:5042", "maxAmountRequired": "<price_wei>",
               "asset": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "payTo": "<contract>",
               "resource": "https://<host>/api/<name>", "description": "…", "mimeType": "application/json",
               "maxTimeoutSeconds": 120,
               "extra": {"name": "USDC", "decimals": 18,
                         "paygate": {"contract": "…", "resource_id": 1, "window_seconds": 3600,
                                     "pay": "pay(uint256,uint32)", "message_format": "paygate:2:…"}}}],
  "scheme": "paygate-native-v2", "chain_id": 5042, "contract": "0x…", "resource_id": 1,
  "price_wei": "10000000000000000", "price_usdc": "0.01", "window_seconds": 3600,
  "discovery": "/.well-known/paygate.json",
  "auth": {"header_address": "X-PayGate-Address", "header_signature": "X-PayGate-Signature",
           "header_payment": "X-PAYMENT", "message_format": "paygate:2:…", "nonce_format": "…",
           "host_format": "…", "nonce": 6005800, "host": "api.example.com", "message": "paygate:2:…"}
}
```

**This is x402-shaped, not x402.** `exact-native` is not a registered x402 scheme, and payment is a
direct native-USDC call to `pay(id, minWindow)` on the PayGate contract, not an EIP-3009
authorization. Generic x402 facilitators cannot settle it. The `X-PAYMENT` payload proves control
of an address that already paid on-chain; it does not authorize a transfer.

A resource that is not for sale (paused, or owned by someone other than `PAYGATE_SELLER`) returns
**503** with the same `scheme/chain_id/contract/resource_id/auth` block but no price and no
`accepts`. Existing holders can still prove access; nobody is told how to pay.

**Discovery** (`GET /.well-known/paygate.json`, `Cache-Control: public, max-age=30`):

```json
{"scheme": "paygate-native-v2", "version": 2, "chain_id": 5042, "network": "eip155:5042",
 "contract": "0x…", "host": "api.example.com | null",
 "auth": {"header_address": "…", "header_signature": "…", "header_payment": "X-PAYMENT",
          "message_format": "paygate:2:…", "nonce_format": "…", "host_format": "…",
          "nonce_period_seconds": 300, "accepted_buckets": "current and previous"},
 "x402": {"x402Version": 1, "scheme": "exact-native", "asset": "0xEeee…EEeE", "registered_scheme": false},
 "resources": [{"name": "polymarket-rewards", "path": "/api/polymarket-rewards", "resource_id": 1,
                "price_wei": "…", "price_usdc": "0.01", "window_seconds": 3600, "active": true,
                "for_sale": true, "seller": "0x…", "uri": "…", "url": "https://api.example.com/api/polymarket-rewards"}]}
```

`url` and `host` appear only when the host is configured or is a verified loopback name. They are
never built from an arbitrary `Host` header. Resources that do not exist on-chain are left out.
The document is untrusted input for buyers: `client.py discover` rebuilds URLs from the base URL
it was given plus a validated path, and `quote`/`fetch` check everything on-chain.

**CORS** (allow-list, default `https://argenestel.github.io`, set with `PAYGATE_CORS_ORIGINS`):

| Response | Headers |
|---|---|
| Preflight `OPTIONS` from an allowed origin | `204`, `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Methods: GET`, `Access-Control-Allow-Headers: X-PayGate-Address, X-PayGate-Signature, X-PAYMENT`, `Access-Control-Max-Age: 600`, `Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers` |
| Any other response to an allowed origin | `Access-Control-Allow-Origin: <origin>`, `Access-Control-Expose-Headers: X-PAYMENT-RESPONSE`, `Vary: Origin` |
| Other origins, including `null` | No CORS headers. Preflight returns `403` |

The server never sends `Access-Control-Allow-Credentials`, because the API uses no cookies. The
only exposed header, `X-PAYMENT-RESPONSE`, holds the caller's own address and expiry, which are
also in the JSON body.

## Threat model

| Asset | Why it matters |
|---|---|
| Buyer funds (hot key, USDC balance) | an agent pays without a human in the loop |
| Paid data | only addresses with live on-chain access may read it |
| Seller revenue and terms | buyers must get what the chain promises, nothing else |
| Server availability | a 402 gate that falls over sells nothing |
| Operator secrets (RPC API key) | often embedded in the RPC URL |

| Adversary | Capabilities |
|---|---|
| Anonymous internet client | arbitrary HTTP: floods, slowloris, oversized requests, forged headers, replayed signatures |
| Malicious or phishing server | answers the buyer's requests with anything, including a genuine 402 copied from the real server |
| Network attacker | sees or modifies traffic that is not protected by TLS |
| Lying RPC endpoint | returns false chain state to whichever side uses it |
| Hostile web origin | runs JavaScript in a visitor's browser against the API |
| Seller | reprices, shrinks the window, pauses or transfers a resource at any time |
| Chain | reorgs, on chains without instant finality |

Out of scope: a compromised buyer machine or key, contract bugs (see `forge test`), Arc consensus.

## Trust boundaries

```
 buyer key --> client.py --(HTTP, UNTRUSTED)--> server.py --(RPC, trusted by server)--> Arc
                  |                                                                      ^
                  +----------(RPC chosen by buyer: reads + tx broadcast)-----------------+
 browser app (allow-listed origin) --(CORS GET)--> server.py
```

- **Server trusts**: its own configuration (`PAYGATE_ADDR`, `PAYGATE_CHAIN_ID`,
  `PAYGATE_PUBLIC_HOST`, `PAYGATE_SELLER`), its RPC (which decides access), and its data
  provider. It trusts nothing in a request except a signature it has verified against its own
  host, chain, contract, resource and clock. `X-Forwarded-For` counts only when the TCP peer is
  in `PAYGATE_TRUSTED_PROXIES`.
- **Client trusts**: its key, its pinned chain id and contract, the URL it chose to request (that
  URL fixes the signed host), and its RPC for reads. It trusts nothing in a 402, 503, 200 or
  discovery body. A lying client-side RPC can make a payment revert (gas lost, capped by
  `--max-fee-usdc`). It cannot redirect funds, because the contract and amount are pinned and the
  transaction is simulated and EIP-155 chain-bound.

## Findings

Audit of the code at commit `3702778` (v1 `py/`, run against the v2 contract), plus a design
review by Grok whose items are credited below. Severity reflects impact in this deployment
(read-only data, small per-call prices, Arc with deterministic finality).

| ID | Severity | Title | Status |
|---|---|---|---|
| PG-01 | High | Signatures were not bound to the server host. A phishing server that relayed a genuine 402 collected a signature valid at the real API for up to 10 minutes (design review, Grok) | **Fixed**: message v2 binds the host. The server uses `PAYGATE_PUBLIC_HOST` or a verified loopback `Host`, otherwise 421. The client rebuilds the message from the URL it requested and refuses a 402 whose `auth.message` differs |
| PG-02 | High | `ThreadingHTTPServer` started one thread per connection with no socket timeout, so a slowloris or a connection flood exhausted threads, memory and file descriptors | **Fixed**: 10 s per socket operation; one 10 s deadline for the whole request head, enforced read by read through `peek()`; at most 64 concurrent connections and 8 per IP. Connections over a cap get an immediate 503/429 from the accept loop |
| PG-03 | Medium | Paused resources returned 503 before access was checked, so buyers with valid paid access were refused (the contract says `hasAccess` ignores `active`) | **Fixed**: access is checked first. The 503 carries the auth block, and the client proves access on a 503 without paying |
| PG-04 | Medium | The client could pay twice. Re-running after a lagging server, or two concurrent fetches, sent a second payment (design review, Grok) | **Fixed**: the client checks on-chain `remaining()` before paying, under a lock per (chain, contract, resource, payer). The lock is in-process plus `flock` on a per-user lock file. It skips payment when 60 s or more remain, and reuses the `latest` nonce so a stuck transaction is replaced, never duplicated |
| PG-05 | Medium | No rate limiting. Requests with bogus signatures cost two ecrecovers each (about 5 ms each with pure-Python eth-keys) plus RPC calls, and every authorized request re-fetched the upstream provider (amplification) | **Fixed**: per-IP token bucket (2 req/s, burst 30, bounded memory); provider output cached 30 s and quotes 5 s, both single-flight; `X-PAYMENT` carries the nonce so it costs one ecrecover |
| PG-06 | Medium | Pinning the contract was optional. Without `PAYGATE_ADDR`, a malicious server could name any contract, including one whose `pay()` keeps the money, bounded only by the spend cap (design review, Grok) | **Fixed**: `fetch` refuses to pay unless a contract is pinned (`PAYGATE_ADDR` or `--contract`) or `--allow-any-contract` is passed |
| PG-07 | Medium | The 402 shipped server-built `pay_calldata`. A naive SDK that sends it pays whatever the server encoded (design review, Grok) | **Fixed**: removed. Buyers build `pay(id, minWindow)` themselves, as the reference client always did |
| PG-08 | Low | The client accepted a server nonce one bucket in the future and signed it, stretching a signature's lifetime to about 15 minutes | **Fixed**: the client signs `min(server nonce, own bucket)` and keeps that skew for retries |
| PG-09 | Low | Request heads were bounded only by the stdlib (100 headers of 64 KiB each), and request bodies were not rejected | **Fixed**: request line over 4 KiB returns 414, head over 16 KiB returns 431, any body returns 413. A lingering close lets the client read the error instead of getting a TCP reset |
| PG-10 | Low | The client read unbounded responses (memory exhaustion by a malicious server), crashed on non-JSON, and echoed raw server text to the terminal (escape-sequence injection) | **Fixed**: 8 MiB cap counted after decompression, redirects off, JSON shape checks, control characters stripped from server text, one-line errors |
| PG-11 | Low | The spend cap ignored gas. On Arc the fee is also USDC, and `maxFeePerGas` came from the RPC's gas price | **Fixed**: `--max-fee-usdc` (default 0.01) caps the worst-case fee (`gas × maxFeePerGas`). `pay()` is simulated with `eth_call` before broadcast, and the tx carries the pinned `chainId` |
| PG-12 | Low | The 402 parser accepted loosely typed fields: `true` as a resource id, floats truncated, string chain ids, negative prices | **Fixed**: strict integer parsing, range checks, consistency check between the two 402s of one fetch, optional `--resource-id` pin |
| PG-13 | Low | `PAYGATE_SELLER` was checked only at startup. With v2 `transferResource`, a resource and its future revenue can move to another address while the server keeps selling it | **Fixed**: with a seller pin, the server stops issuing payment instructions (503 "owner changed") once the on-chain seller differs. Existing access is still served |
| PG-14 | Low | The server never checked that `PAYGATE_ADDR` is a v2 PayGate. A v1 (inclusive expiry) or unrelated contract surfaced only as 502s | **Fixed**: the startup preflight calls `remaining()` and `MAX_PAGE()` and checks chain id, code, resources, seller pin and providers |
| PG-15 | Info | Access used two reads (`hasAccess`, then `accessUntil`) that could land on different blocks, and relied on the boolean only | **Fixed**: one `remaining()` call decides, using block time and exclusive at expiry (tested: `until-1` returns 200, `until` returns 402). `accessUntil` is read only for display; it can only grow, so the second read cannot race |
| PG-16 | Info | Version disclosure (`Server: PayGate/1 Python/3.x`) and HTML error pages | **Fixed**: `Server: PayGate`, JSON errors with CORS, `X-Content-Type-Options: nosniff` |
| PG-17 | Info | Unknown paths returned 200, and `urlparse` read `//api/x` as a netloc | **Fixed**: 404 for unknown paths; the path is split without `urlparse` |
| PG-18 | Info | `price_usdc` used 28-digit `Decimal` division (rounding at large prices, `1E-18` notation) | **Fixed**: exact integer formatting |
| PG-19 | Info | The RPC URL, which often embeds an API key, was printed at startup and could appear in exception text | **Fixed**: redacted at startup; the logger scrubs the configured RPC URL from every line |
| PG-20 | Info | Duplicate auth headers silently resolved to the first value, a source of proxy and server disagreement | **Fixed**: 400 |
| PG-21 | Info | Chain reorgs: the server reads `latest`. On a reorg-prone chain, a payment later reorged out could already have been served | **Mitigated**: Arc has deterministic finality, so `latest` is final. Elsewhere set `PAYGATE_BLOCK_TAG=finalized` (or `safe`); access then starts after the finality lag, and clients need more `--retries` |
| PG-22 | Info | A signature is a bearer token for 5 to 10 minutes. Anyone who sees it (TLS-terminating proxy logs, a browser extension) can read the same resource until it expires | **Accepted**: by design, read-only, bound to host, chain, contract and resource. The server never logs proof headers; operators must not either (see below) |
| PG-23 | Info | Signature malleability: high-`s` and `v ∈ {0,1}` variants verify | **Accepted**: no impact, since every variant authenticates the same signer for the same message |
| PG-24 | Info | The spend cap is per payment, not per session, and the payment lock is per machine | **Accepted**: `fetch` pays at most once per call, and the on-chain check stops repeat payments while access is live. Agents on several machines sharing one key should use separate keys |
| PG-25 | Info | `exact-native` is not a registered x402 scheme | **Documented**: x402-shaped only; see the protocol reference |

## Operational guidance

**Deploy behind a TLS reverse proxy.** Signatures are bearer tokens, so plain HTTP leaks them.
Example:

```
PAYGATE_ADDR=0x… PAYGATE_RPC=https://<your-rpc> PAYGATE_SELLER=0x<seller> \
PAYGATE_PUBLIC_HOST=api.example.com PAYGATE_TRUSTED_PROXIES=127.0.0.1 \
python py/server.py --host 127.0.0.1 --port 8402 --json
```

- Bind to `127.0.0.1` and let only the proxy reach the server. The default `0.0.0.0` exists for
  local experiments.
- **Set `PAYGATE_PUBLIC_HOST`** to the exact host[:port] clients use. Without it the server
  answers only loopback names and returns 421 for everything else.
- Have the proxy set `X-Forwarded-For`, and list the proxy's address in
  `PAYGATE_TRUSTED_PROXIES`. Otherwise every buyer shares the proxy's rate-limit bucket. Never
  list an address that untrusted clients can connect from.
- Keep edge limits at or below the server's: header timeout about 10 s, head size 16 KiB, no
  request bodies. Terminate HTTP/2 and TLS at the proxy.
- **Do not log `X-PayGate-Signature` or `X-PAYMENT`** at the proxy. They are live credentials
  for up to 10 minutes. `--json` server logs contain the client IP and payer address, which is
  personal data; set retention accordingly.
- Install `coincurve` in the server's environment. eth-keys then verifies signatures natively
  (about 50 µs instead of about 5 ms), which makes signature-spraying floods much cheaper to absorb.

**RPC choice.** The server's RPC decides who gets served:
- Use an endpoint you control or pay for, not a public free tier. A lagging node delays access;
  a lying node can grant or deny access, but it cannot move funds.
- Keep the API key in `PAYGATE_RPC`, never in code. The startup line shows only scheme and host.
- Load is bounded: at most 1 `quote` per resource per 5 s for unauthenticated traffic, and 2
  `eth_call`s per authorized request (`remaining`, plus `accessUntil` on success).
- Buyers should use an RPC independent of the seller's. The client re-reads the price and window
  from its own RPC and simulates the payment there.

**Client key handling.**
- Use a dedicated hot wallet per agent, funded with only what the agent should spend. The spend
  cap limits each payment, and the balance limits the total.
- Pass the key through `EVM_PRIVATE_KEY` or `--key-file` (mode 0600), never as a command-line
  argument (visible in `ps` and shell history). The client never prints or logs the key.
- Always pin `--contract`/`PAYGATE_ADDR` and `--chain-id`. Add `--resource-id` when you know it.
  Keep `--max-usdc` and `--max-fee-usdc` tight.
- Use https URLs. The client refuses plain http to non-loopback hosts unless `--allow-http`.
- Concurrent runs on one machine share the lock directory (`~/.cache/paygate/locks`, or
  `PAYGATE_LOCK_DIR`). Keep it on local disk, because `flock` over NFS is unreliable.

## Tests

`cd py && ../../.venv/bin/python -m unittest -v test_e2e` runs 30 end-to-end tests on a local
anvil chain. They cover every finding above: host binding and phishing relays, the exact-expiry
boundary, paused-resource access, seller transfer, X-PAYMENT, discovery, CORS, rate limits,
oversized and malformed requests, slowloris, connection caps, caches, JSON logs, double-payment
races (threads and processes), fee caps, the client and server CLIs, and ABI drift. Set
`PAYGATE_TEST_ARTIFACT=/path/to/PayGate.json` to test a specific contract build instead of
`../out`.
