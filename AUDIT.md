# PayGate v2 security audit

| | |
|---|---|
| Scope | `src/PayGate.sol` at commit `3702778` (151 nSLOC before fixes, 171 after) |
| Compiler | solc 0.8.26, optimizer 200 runs, `evm_version = cancun` |
| Target chain | Arc (Circle EVM L1): mainnet 5042, testnet 5042002. Native gas token is USDC, `msg.value` has 18 decimals |
| Out of scope | `py/`, `docs/`, `app/`, the off-chain 402 server, Arc's node and USDC system contracts |
| Inputs folded in | Independent review (Codex) and design review (Grok), credited per finding |
| Result | No Critical, High or Medium findings. 4 Low (3 fixed, 1 acknowledged), 15 Info (2 fixed, 13 acknowledged) |

## ABI and behaviour changes

All of these are **additions**. Every stable signature is unchanged: `quote`, `pay`, `payFor`, `hasAccess`, `accessUntil`, `remaining`, `getResource`, `getResources`, `createResource`, `updateResource`, `transferResource`, `withdraw`, `withdrawTo`, `balances`, `nextId`. The events are unchanged too.

| Added | Kind | Why |
|---|---|---|
| `PRICE_UNIT() → uint256` (= 1e12) | constant | PG-01 |
| `MAX_WINDOW() → uint32` (= 365 days) | constant | PG-03 |
| `error PricePrecision(uint96 price)` | error | PG-01 |
| `error WindowTooLong(uint32 window)` | error | PG-03 |

Behaviour changes that clients should know about:

1. `createResource` / `updateResource` now revert if `price % 1e12 != 0` or `window > 365 days`.
2. Zero-price payments no longer stack. A free claim sets `until = max(existing, now + window)`. Paid purchases still stack.
3. `Withdrawn` is now emitted before the value transfer. It is the same transaction with the same content; only its order relative to logs from the recipient's hook changes.

Clients that decode errors (`py/abi.json`, `app/src/abi.ts`) should add the two new errors. Any instance deployed from `3702778` needs a redeploy to pick up the fixes.

## Methodology

1. **Manual line-by-line review** covering:
   - access control and reentrancy (single- and cross-function)
   - integer bounds and storage packing (checked with `forge inspect PayGate storageLayout` and a `vm.load` test)
   - gas and DoS on the views
   - behaviour for every function on ids that don't exist
   - event completeness, and front-running between quote and pay
   - free resources and `transferResource` semantics
   - Arc-specific value-transfer semantics, checked against [Arc's EVM-differences reference](https://docs.arc.io/build/evm-differences) and [stablecoin-native model](https://docs.arc.io/arc/concepts/stablecoin-native-model.md)
2. **Unit and fuzz tests** for every v2 feature and every finding: `test/PayGateV2.t.sol` and `test/PayGateGas.t.sol`, plus the existing `test/PayGate.t.sol`.
3. **Stateful invariant testing**, handler-based and model-checked (`test/invariant/`): 256 runs × depth 64, so 16,384 calls per invariant.
4. **Mutation testing of the suites.** Eight deliberate bugs were injected into `src/`, and the suites were confirmed to catch every one (see below).
5. **Static analysis** with Slither 0.11.6 and Aderyn 0.6.8, run before and after the fixes, with every result triaged.
6. **Gas measurement**: real transaction receipts on a local `anvil` (chain id set to 5042002, no real network), for both the baseline and the fixed contract, plus a deterministic `forge snapshot`.

## Findings

| ID | Severity | Title | Status | Source |
|---|---|---|---|---|
| PG-01 | Low | Price denomination confusion (6-decimal ERC-20 vs 18-decimal native USDC) | Fixed | audit |
| PG-02 | Low | Free access can be stockpiled and survives a later reprice | Fixed | Codex, Grok |
| PG-03 | Low | Unbounded access window ("1 wei for 136 years" typo) | Fixed | Grok |
| PG-04 | Low | USDC sent via the ERC-20 interface (or forced) is stranded | Acknowledged | Codex, audit |
| PG-05 | Info | `Withdrawn` emitted after the external call | Fixed | audit, Slither |
| PG-06 | Info | Floating pragma | Fixed | Aderyn |
| PG-07 | Info | Issuer freeze / blocklist can lock balances; `withdrawTo` only partly mitigates it | Acknowledged | Codex, audit |
| PG-08 | Info | Seller can change terms just before a buyer's `pay` (gas-only grief) | Acknowledged | Grok |
| PG-09 | Info | Exact-amount check also reverts a buyer when the price drops | Acknowledged | Grok |
| PG-10 | Info | `sales` / `revenue` are not a trust signal (wash sales, free-claim spam) | Acknowledged | Grok, audit |
| PG-11 | Info | Access is per address; keys or proxies can be shared | Acknowledged | Grok |
| PG-12 | Info | No refunds, no delivery guarantee | Acknowledged | Grok |
| PG-13 | Info | Sequential ids and free-form URIs allow squatting and impersonation | Acknowledged | Grok, audit |
| PG-14 | Info | Single-step `transferResource` | Acknowledged | audit |
| PG-15 | Info | `Paid` does not name the credited seller | Acknowledged | audit |
| PG-16 | Info | `uri` is untrusted seller input (XSS / phishing in frontends) | Acknowledged | audit |
| PG-17 | Info | `getResources` page cost (~4.6M gas, ~83 KB at the maximum) | Acknowledged | audit, Codex |
| PG-18 | Info | Return data from the withdraw recipient is copied (self-only returnbomb) | Acknowledged | audit |
| PG-19 | Info | Value can arrive at the contract without `pay` (forced send) | Acknowledged | audit |

### PG-01 (Low, Fixed): price denomination confusion

**Description.** Arc exposes one USDC balance through two interfaces: native value at 18 decimals, and the ERC-20 at `0x3600…0000` at 6 decimals. Arc's docs warn never to mix the raw values. `price` is native wei, but nothing stopped a seller or a tool from passing a 6-decimal amount. For example, `10_000` meant as 0.01 USDC is actually 1e-14 USDC.

**Impact.** The resource sells for about 10⁻¹² of its intended price until someone notices. Buyers aren't harmed; the seller loses revenue. Sub-micro prices also leave balances with dust that the ERC-20 `balanceOf` view truncates away.

**Fix.** Added `PRICE_UNIT = 1e12`, and `_checkTerms` now reverts with `PricePrecision(price)` unless `price % 1e12 == 0` (0 is allowed). Any 6-decimal amount below 1M USDC is not a multiple of 1e12, so the common mistake now reverts at creation. Prices are now always whole micro-USDC, the finest unit the ERC-20 view can show. Cost: +198 gas on create, +109 on update. Nothing on `pay`.

**Tests.**
- `test_create_rejects_six_decimal_price`
- `test_create_rejects_sub_micro_remainder`
- `test_update_rejects_sub_micro_price`
- `test_price_precision_accepts_zero_one_micro_and_max`
- `testFuzz_price_precision`
- invariant I-7 (`price % PRICE_UNIT == 0` for every resource)

### PG-02 (Low, Fixed): free access stockpiling

**Description.** While `price == 0`, each `pay`/`payFor` extended `accessUntil` by a full window from the existing expiry. 365 calls against a 1-day window bought a year. That access outlived a later reprice or pause, because `hasAccess` ignores `active` and price by design.

**Impact.** A seller who launches free and later starts charging cannot actually charge early users who stockpiled. Anyone can also stockpile for any beneficiary via `payFor`.

**Fix.** Zero-value payments set `until = max(existing, now + window)`: they refresh and never stack. They also never shorten access that was paid for earlier. Paid purchases keep stacking. `sales` still counts every claim. Effect on gas: −2,720 on a repeated free claim, +80 on paid pays.

**Tests.**
- `test_free_claims_do_not_stack` (365 claims → 1 window)
- `test_free_claim_refreshes_from_now`
- `test_free_stockpile_does_not_survive_reprice`
- `test_free_claim_via_payFor_does_not_stack`
- `test_free_claim_never_shortens_paid_access`
- `test_paid_claims_still_stack_after_free_claim`
- `testFuzz_accessUntil_monotonic`
- invariant I-4: every successful pay is compared with the model "paid stacks on max(now, prev); free refreshes to max(prev, now + w)"

### PG-03 (Low, Fixed): unbounded window

**Description.** `window` accepted any `uint32` up to about 136 years. A typo, such as seconds entered as milliseconds or a misplaced digit, could sell near-permanent access for one price.

**Fix.** Added `MAX_WINDOW = 365 days`. `_checkTerms` reverts with `WindowTooLong(window)` above it. This also tightens the `uint64 accessUntil` overflow margin from about 4e9 to about 5.8e11 stacked purchases.

**Tests.**
- `test_create_rejects_window_over_max`
- `test_update_rejects_window_over_max`
- `test_window_at_max_ok`
- `testFuzz_window_bounds`
- `test_pay_max_window_stacks_without_overflow`
- invariant I-7

### PG-04 (Low, Acknowledged): ERC-20 transfers to PayGate are stranded

**Description.** On Arc, `USDC.transfer(payGate, x)` through the ERC-20 interface moves the same native balance, but it doesn't execute PayGate's code. The tokens arrive without `_pay` running: the sender gets no access, no seller is credited, and since there is no owner, nobody can ever withdraw them. A `receive`/`fallback` can't reject these transfers, because no code runs.

**Impact.** Integrations that "pay" with an ERC-20 transfer lose those funds. Existing balances are unaffected: per-seller accounting never reads `address(this).balance`.

**Decision.** Document this rather than change code. Integrations must call `pay`/`payFor`; the Python client (`py/client.py`) and the web app (`app/src/components/BuyPanel.tsx`) already do.

We considered a `totalOwed` counter with a `surplus()` view, as Codex suggested, and rejected it:
- It adds a cold SLOAD + SSTORE (about 5,000 gas) to every paid `pay` and every withdrawal. That is +8% on a first payment (61k) and +11% on a repeat (44k), all to power a diagnostic view.
- Without an owner or any record of who sent the funds, the surplus still can't be returned. An unrestricted sweep would just be a race.
- `surplus = address(this).balance − Σ balances` can be computed off-chain from logs.

The invariant suite tracks it exactly, through log-replay ghosts (I-1).

### PG-05 (Info, Fixed): `Withdrawn` emitted after the external call

**Description.** `_withdraw` zeroed the balance before the call, so it was already reentrancy-safe. But it emitted `Withdrawn` after the call. If the recipient's hook paid a resource owned by the same seller, logs came out as `Paid` then `Withdrawn(amt)`. An indexer that resets the seller balance to zero on `Withdrawn` would then drop the nested credit. Slither flagged this as `reentrancy-events`.

**Fix.** `Withdrawn` is now emitted before the call, which gives strict checks-effects-interactions. Replaying logs in order now matches on-chain balances, whether the indexer resets to zero or subtracts. Indexers should still **subtract `amount`** rather than reset, because that stays correct under any ordering (Codex).

**Tests.**
- `test_withdrawn_logged_before_receiver_callback`: log order `Withdrawn`, `Paid`; the replay equals `balances`
- `test_withdraw_reentry_pays_once`
- `test_withdraw_reentrancy_cannot_drain`
- invariant I-1: contract balance == log-replayed deposits − withdrawals, with a receiver that re-enters `withdraw` and pays from its hook

### PG-06 (Info, Fixed): floating pragma

`pragma solidity ^0.8.26` is now `pragma solidity 0.8.26` in `src/`, matching the audited compiler. Aderyn L-2.

### PG-07 (Info, Acknowledged): custody under issuer controls

Arc enforces Circle's USDC blocklist at runtime: "a value transfer to or from a blocklisted address reverts", and a reverting blocklist check still consumes gas. The cases:

| Who is restricted | Effect | Mitigation |
|---|---|---|
| A seller's own address, as a recipient | `withdraw()` reverts with `TransferFailed`; the balance is kept, because the revert is atomic | `withdrawTo(clean)` |
| A seller contract or EIP-7702 account whose hook reverts | Same as above | `withdrawTo(clean)` |
| A seller EOA that cannot originate transactions | The balance is locked until the restriction lifts. Arc's docs don't say whether a blocklisted EOA can still pay gas. `withdrawTo` doesn't help, because it is the caller's own balance. | None, by design |
| PayGate itself frozen | Every `pay` (value in) and every withdrawal (value out) reverts. All balances are frozen in place. No owner exists to rescue them. | None, by design |
| Buyer | Cannot send `pay`. A clean payer can still `payFor` them, since no value goes to the beneficiary. | n/a |

Arc's docs don't describe a global pause of native USDC. If transfers were halted, every value-moving call would revert atomically, with no partial state, and withdrawals could be retried later. Every value movement in PayGate is in the same transaction as its accounting, so no restriction can corrupt the books. At worst it freezes them. PayGate does not enforce sanctions itself; that is the issuer's protocol-level control. This is listed under trust assumptions.

### PG-08 (Info, Acknowledged): terms change right before `pay`

A seller (or a seller's bot) can change price, window, `active` or URI in the same block before a buyer's `pay`. The buyer cannot overpay: the exact-amount check guards the price, `minWindow` guards the window, and `Inactive` guards pausing. So the worst case is a reverted transaction and lost gas, about 0.0012 USDC at Arc's 20 gwei base-fee floor.

A `TERMS_DELAY` (timelocked terms) would add a storage slot to every resource, a pending-terms UX, and delayed repricing for honest sellers, all to prevent a grief that costs gas only. Not adopted. The URI has no on-chain guard; see PG-13 and PG-16.

**Test:** `test_pay_reverts_when_seller_frontruns_price`, `test_pay_reverts_when_seller_frontruns_window`, `test_pay_inactive_reverts`.

### PG-09 (Info, Acknowledged): a price decrease also reverts

`msg.value != price` reverts in both directions, so a buyer whose quote is stale must refresh even if the new price is lower. Accepting overpayment would need refunds (an external call in `_pay`, which is a reentrancy surface) or buyer credit (new state and new withdrawal paths). Deliberately not done; the web app shows `WrongAmount` as "price changed, refresh".

**Test:** `test_pay_reverts_when_seller_frontruns_price` (both directions).

### PG-10 (Info, Acknowledged): `sales` / `revenue` are not a trust signal

A seller can pay their own resource, and the money comes straight back on `withdraw`, so `sales` and `revenue` can be inflated for the cost of gas. Free resources count every claim as a sale, and anyone can spam claims. Lifetime stats belong to the resource and carry over through `transferResource`. Frontends must not present these numbers as reputation.

**Test:** `test_free_resource_counts_sales_not_revenue`, `test_transfer_preserves_stats_and_access`.

### PG-11 (Info, Acknowledged): access is per address

`hasAccess(who, id)` grants access to an address. A buyer can share a key, or run a proxy that re-serves the content. Per-use metering, or binding access to a session, is out of scope for v2. The 402 server's signed-nonce check proves control of the address, not exclusivity.

### PG-12 (Info, Acknowledged): no refunds, no delivery guarantee

A payment buys an on-chain entitlement (`accessUntil`). Whether the seller's server actually delivers is off-chain. PayGate has no escrow, dispute or refund path, which keeps it owner-less and keeps `_pay` free of external calls. Buyers trust the seller to deliver; the price per window bounds the exposure.

### PG-13 (Info, Acknowledged): id squatting and URI impersonation

Ids are sequential (`nextId++`), so the id a seller expects can be taken by a transaction ordered before theirs. Anyone can also create a resource whose `uri` copies another seller's. Clients must take the id from the seller's own 402 response (over TLS), check that `quote(id).seller` is the expected seller (the server supports `PAYGATE_SELLER` pinning), and read the created id from the `createResource` return value or the `ResourceCreated` event, never by predicting `nextId`. The deploy script already uses the return value.

**Test:** `test_nonexistent_ids_in_every_function` ("squat" updates on unknown ids revert with `NotSeller`).

### PG-14 (Info, Acknowledged): single-step `transferResource`

Ownership moves immediately, with no accept step. If a seller transfers to a wrong address, they lose control and all future revenue. That includes an address that can't send transactions, or the PayGate contract itself: PayGate can never call `withdraw`, so revenue for a resource it "owns" would be stranded. A transfer that lands between a buyer's quote and pay sends that payment to the new seller. The buyer's price and window are still enforced and access is still granted.

A two-step transfer would change the semantics the server and app rely on. The NatSpec now warns, and frontends should confirm the destination.

**Tests.**
- `test_transfer_then_pay_credits_new_seller_old_keeps_earned`
- `test_transfer_moves_control`
- `test_transfer_between_quote_and_pay_routes_to_new_seller`
- `test_transfer_to_self_is_noop`
- `test_transfer_zero_reverts`
- `test_transfer_only_seller`
- `test_transfer_unknown_id_reverts`

### PG-15 (Info, Acknowledged): `Paid` does not name the credited seller

To attribute revenue per seller from logs, an indexer must replay `ResourceTransferred` in log order and use the seller at the time of each `Paid`. `ResourceUpdated` also omits the seller. Both are derivable, and all ids and addresses that matter are indexed. Adding a field would change the `Paid` topic0, which `docs/` and the web app subscribe to, so it is not done. For balances, `balances(seller)` is the source of truth.

### PG-16 (Info, Acknowledged): `uri` is untrusted

`uri` is up to 512 arbitrary bytes chosen by the seller (`javascript:`, `data:`, look-alike domains, markup). Frontends must render it as text, link only `https:` (allow-list the scheme), and never inject it as HTML.

### PG-17 (Info, Acknowledged): `getResources` page cost

Measured with every slot cold (`vm.cool`):
- 100 resources with 512-byte URIs: **4,618,751 gas, 83,264 bytes of returndata**
- 25 resources: 1,132,619 gas, 20,864 bytes

On anvil, `eth_estimateGas` for a page of 100 was 4.33M. Both fit a 50M `eth_call` cap more than 10 times over, and loop bounds are capped by `MAX_PAGE`. State-changing functions have no loops. Large responses can still hit public-RPC response-size limits, so frontends should page with `limit <= 25`, as the web app does.

**Tests.**
- `test_getResources_full_page_of_max_uris_fits_eth_call_cap`
- `test_getResources_web_page_of_25_max_uris`
- the pagination edge tests (see Coverage)

### PG-18 (Info, Acknowledged): returndata copy on withdraw

`(bool ok,) = to.call{value: amt}("")` copies the recipient's return data. A recipient returning huge data makes the withdrawal expensive. But `to` is always `msg.sender` or an address the caller chose, so it only harms the caller.

### PG-19 (Info, Acknowledged): forced value

PayGate has no `receive`/`fallback`, so plain transfers revert (`test_stray_value_transfer_reverts`). Value can still arrive without `pay`: EIP-6780 `SELFDESTRUCT` is allowed on Arc, and the ERC-20 path is covered in PG-04. Such value is stranded, can't be withdrawn by anyone, and never affects seller accounting. With forced sends the solvency property is `balance >= Σ balances`. In the invariant suite, where no actor can force-send, it is checked with `==`.

## Verified properties (no finding)

- **Access control.** `updateResource` and `transferResource` are `onlySeller`. Ids that don't exist have `seller == address(0)`, and no `msg.sender` can be zero, so they always revert with `NotSeller`. Withdrawals only ever move `balances[msg.sender]`. The seller cannot revoke or shorten paid access (`test_seller_cannot_revoke_paid_access`).
- **Reentrancy.** `_pay` makes no external calls. `_withdraw` follows checks-effects-interactions. A re-entrant `withdraw` sees zero and reverts. Cross-function re-entry (paying from the hook) keeps the books exact (I-1 to I-3 with `PayingReceiver`). Read-only reentrancy is safe, because the state is final before the call.
- **Integer bounds** (all arithmetic is checked: an overflow reverts, it never wraps):

  | Field | Bound | Margin |
  |---|---|---|
  | `accessUntil` (uint64) | grows by at most 365 days per paid purchase | overflow needs about 5.8e11 purchases |
  | `revenue` (uint128) | grows by at most 2⁹⁶ wei per payment | overflow needs 2³² max-price payments |
  | `sales` (uint64) | grows by 1 per payment | 1.8e19 payments |
  | `price` (uint96) | at most 7.9e10 USDC | n/a |
  | `uint128(msg.value)` cast | safe, because `msg.value == price < 2⁹⁶` | n/a |

  **Tests:** `test_accessUntil_overflow_reverts_not_wraps`, `test_sales_overflow_reverts_not_wraps`, `test_max_price_payments_accumulate`.
- **Storage packing matches the comment.** `forge inspect PayGate storageLayout`:
  - the struct takes 3 slots
  - slot 0: `seller` (offset 0, 20 bytes) and `price` (offset 20, 12 bytes)
  - slot 1: `window` (offset 0), `active` (4), `sales` (5), `revenue` (13); 29 of 32 bytes used
  - slot 2: `uri`

  `test_storage_packing_matches_comment` decodes the raw slots with `vm.load`. `_pay` reads slots 0 and 1 and rewrites slot 1 for the stats.
- **Expiry is exclusive.** Access bought at time t with window w is valid for t ≤ now < t + w, and a repurchase exactly at expiry restarts from now with no lost second. Arc block timestamps are non-decreasing, not strictly increasing; this logic only needs monotonicity.

**Ids that don't exist** (0, and any id ≥ `nextId`) behave the same in every function (`test_nonexistent_ids_in_every_function`):

| Function | Result |
|---|---|
| `quote`, `getResource` | All fields zero (`getResource` echoes the id). `seller == 0` means the resource doesn't exist. |
| `getResources` | Only ever returns ids in `[1, nextId)` |
| `pay`, `payFor` | Revert with `Inactive` (`payFor` checks `ZeroAddress` first) |
| `updateResource`, `transferResource` | Revert with `NotSeller` |
| `hasAccess`, `remaining`, `accessUntil` | `false` / 0 / 0. No one can ever pay for such an id. |

**Event completeness.** The full state can be rebuilt from five events:
- `ResourceCreated` and `ResourceUpdated` carry every term (`active = true` on create)
- `ResourceTransferred` carries the seller history
- `Paid` carries the amount and the resulting `until`, so `accessUntil` can be rebuilt without reproducing the stacking rules
- `Withdrawn` carries the amount

Indexers that use Arc's EIP-7708 native `Transfer` logs should not double-count them against `Paid`/`Withdrawn`.

## Invariants

The suite is `test/invariant/PayGate.invariant.t.sol` with the handler in `test/invariant/PayGateHandler.sol`:
- **Actors:** 6 in total. Four are EOAs; one is `RevertingReceiver`, whose hook reverts; one is `PayingReceiver`, which re-enters `withdraw` and pays from its hook.
- **Resources:** at most 8, plus id 0 and the first unused id.
- **Actions:** create, update, transfer, pay (weighted ×2), payFor, withdraw, withdrawTo (recipients include the gate, `address(0)` and the reverting receiver), and warp.
- **Outcome checks:** before every call, the handler predicts the exact outcome, either success or the specific custom error, from its own model.

| # | Invariant | Result (256 runs × depth 64) |
|---|---|---|
| I-1 | `address(gate).balance == Σ balances(actor)` == log-replayed deposits − withdrawals (no wei stuck or created) | pass, 16,384 calls |
| I-2 | For every resource, `revenue == Σ Paid.amount` for that id; `Σ revenue ==` total deposits | pass, 16,384 calls |
| I-3 | `sales == count(Paid)` per id; `Σ sales ==` successful pay calls, including pays made inside a withdraw callback | pass, 16,384 calls |
| I-4 | `accessUntil` never decreases for any actor and id (checked after every call); each pay's expiry equals the model; `hasAccess` and `remaining` agree with `accessUntil` | pass, 16,384 calls |
| I-5 | A non-seller can never change a resource: on-chain seller, price, window, `active` and `uri` equal a model that only applies seller-authorised updates and transfers; seller is never 0 | pass, 16,384 calls |
| I-6 | Every call matched its predicted outcome, and every successful pay or withdrawal moved exactly the expected amount | pass, 16,384 calls |
| I-7 | `getResources(0, max)` equals `getResource` for each id; the page length is correct; terms stay within `PRICE_UNIT`, `MAX_WINDOW` and `MAX_URI` | pass, 16,384 calls |

**Handler coverage** was sampled over a 2,000-call run:
- about 50% of pays succeed
- 336 successful pays and 10 nested callback pays
- every custom error was hit: `NotSeller`, `Inactive`, `WrongAmount`, `WindowTooShort`, `ZeroWindow`, `WindowTooLong`, `ZeroAddress`, `UriTooLong`, `PricePrecision`, `NothingToWithdraw`, `TransferFailed`

**Mutation testing.** Each mutant was injected into `src/` in turn, then the original source was restored and confirmed byte-identical:

| Mutant | Invariants that caught it | Failing unit tests |
|---|---|---|
| No seller credit in `_pay` | I-1, I-6 | 36 |
| Free claims stack again | I-4 | 10 |
| `onlySeller` check removed | I-1, I-2, I-3, I-5, I-6 | 10 |
| `sales` only counted when paid | I-3 | 4 |
| Balance zeroed after the call (reentrancy) | I-1, I-2, I-3, I-6 | 4 |
| Inclusive expiry (`>=`) | I-4 | 6 |
| `transferResource` without `onlySeller` | I-5, I-6 | 8 |
| `revenue` double-counted | I-2 | 10 |

## Gas

These are real transaction `gasUsed` values from anvil receipts, including the 21,000 intrinsic cost and calldata, at a price of 0.01 USDC and a 1-hour window.

| Operation | Baseline `3702778` | Audited | Δ |
|---|---:|---:|---:|
| `pay`: first payment by a new buyer | 61,012 | **61,092** | +80 |
| `pay`: first payment ever credited to a seller (balance 0→x) | 78,112 | 78,192 | +80 |
| `pay`: repeat payment (stacking) | 43,908 | **43,982** | +74 |
| `payFor`: new beneficiary | 61,436 | 61,516 | +80 |
| `pay`: free claim, first / repeat | 55,036 / 37,932 | 55,112 / 35,212 | +76 / −2,720 |
| `createResource`: 31-byte URI | 98,104 | **98,302** | +198 |
| `createResource`: 512-byte URI | 464,741 | 464,939 | +198 |
| `updateResource`: same-length URI | 39,441 | 39,550 | +109 |
| `transferResource` | 29,264 | 29,220 | −44 |
| `withdraw` | 30,442 | **30,465** | +23 |
| `withdrawTo` | 33,454 | 33,565 | +111 |
| Deploy | 1,225,770 | 1,298,865 | +73,095 |

At Arc's 20 gwei base-fee floor, a first `pay` costs about 0.0012 USDC in gas.

`.gas-snapshot` holds per-test execution gas, regenerated with `forge snapshot --no-match-test "testFuzz|invariant"`. Fuzz and invariant tests are excluded so that `--check` is deterministic. The isolated hot paths are in `PayGateGasTest`. The snapshot figure for `test_gas_withdraw` includes Ethereum's 25,000 new-account surcharge, because the test seller address starts empty. Real sellers have paid gas before, so they already exist.

## Tool output

**Slither 0.11.6** (`uv tool run --from slither-analyzer slither . --filter-paths "lib|test|script"`):

| Detector | Before | After | Triage |
|---|---|---|---|
| reentrancy-events (`Withdrawn` after the call) | 1 | 0 | Fixed (PG-05) |
| timestamp (`hasAccess`, `remaining`, `_pay`) | 3 | 3 | By design: access windows are time-based. Arc timestamps are non-decreasing and a few seconds of skew is irrelevant at window granularity. |
| low-level-calls (`to.call{value:}`) | 1 | 1 | Intended: a native transfer that forwards all gas, with the result checked and reverting with `TransferFailed` |

**Aderyn 0.6.8** (`aderyn . --src src`):

| Finding | Before | After | Triage |
|---|---|---|---|
| H-1 "ETH transferred without address checks" (`withdraw`) | 1 | 1 | False positive: it sends only `balances[msg.sender]` to `msg.sender` |
| L-1 PUSH0 opcode | 1 | 0 | Arc targets the Osaka baseline, where PUSH0 (Shanghai) is available |
| L-2 unspecific pragma | 1 | 0 | Fixed (PG-06) |

**Manual pass over the remaining detector classes:**
- unchecked return values: none
- `tx.origin`: none
- `delegatecall` / `selfdestruct`: none
- uninitialised storage: none
- arbitrary `from` / `send`: none, since every value-out is the caller's own balance
- unbounded loops in state-changing code: none
- shadowing: none
- division before multiplication: none
- unsafe casts: only `uint64(block.timestamp)` and `uint128(msg.value)`, both bounded (see above)

`forge build` produces no compiler or lint warnings.

## Coverage of v2 features

| Feature | Tests |
|---|---|
| Pagination | `test_getResources_empty_gate`, `test_getResources_fromId_zero_is_one`, `test_getResources_past_end_and_limit_zero` (`fromId == nextId`, `uint256.max`, `limit == 0`), `test_getResources_limit_clamped_to_max_page` (`MAX_PAGE + 1`, `uint256.max`), `test_getResources_exact_page_boundaries` (250 ids: 100/100/50, last id, one past the end, the web app's 25-page), `test_getResources_reflects_current_state`, `testFuzz_getResources` |
| `withdrawTo` | to zero, to a reverting receiver, to the gate itself, with nothing to withdraw, rescue for a rejecting seller, a fuzzed caller can only move its own balance, event check |
| `transferResource` | see PG-14 |
| `UriTooLong` | create and update at 513 bytes; 512 and empty accepted; `testFuzz_uri_cap` |
| `remaining()` | `test_remaining_lifecycle`, `testFuzz_remaining_matches_hasAccess` |
| Stats and views | `test_getResource_fields_and_stats`, `test_stats_survive_update_and_pause`, `test_free_resource_counts_sales_not_revenue`, `test_storage_packing_matches_comment` |
| Events | `test_events_create_update`, `test_event_payFor_distinguishes_payer_and_beneficiary`, `test_transfer_emits_event`, `test_withdrawTo_sends_to_recipient_and_emits`, `test_pay_emits_event` |

Totals: 107 tests (90 unit, 10 fuzz at 256 runs each, 7 invariants at 256 × 64), all passing.

## Trust assumptions

- **No admin.** There is no owner, pauser, upgrade path or fee switch. Nobody can rescue, sweep or censor, and that includes stranded value (PG-04, PG-19) and the balances of a lost or frozen seller.
- **Circle and Arc.** PayGate's balances are only as available as native USDC itself. The issuer's blocklist, or a freeze of the PayGate address, can lock balances in place indefinitely (PG-07). Arc's consensus and the native-USDC system contracts are trusted. Transactions are final on inclusion, so the off-chain server may grant access after one confirmation.
- **Sellers** are trusted to deliver what they sell (PG-12) and to keep terms stable (PG-08, PG-09). They cannot take buyers' money beyond the exact quoted price, and cannot revoke access already bought.
- **Clients and servers** must pin the contract address, resource id and seller (PG-13), treat `uri` as untrusted (PG-16), price in native 18-decimal wei (PG-01), and pay through `pay`/`payFor`, never by ERC-20 transfer (PG-04).
- **Indexers** must order logs by block number and log index, subtract `Withdrawn.amount` (PG-05), and replay transfers to attribute revenue (PG-15).
