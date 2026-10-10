"""Agent-side client: fetch a PayGate resource, paying on Arc in native USDC if asked.

Usage: EVM_PRIVATE_KEY=0x... python client.py http://localhost:8402/api/polymarket-rewards
Env:   PAYGATE_RPC       RPC url (default Arc mainnet)
       PAYGATE_CHAIN_ID  chain the agent is willing to pay on (default 5042)
       PAYGATE_ADDR      optional: only pay this PayGate contract, whatever the server says
       PAYGATE_MAX_WEI   spend cap per payment in wei (default 0.1 USDC = 1e17)

Trust model: the 402 body is *untrusted*. The client never sends server-supplied calldata and
never signs server-supplied text. It reads the quote from the contract itself, builds
`pay(id, minWindow)` locally, enforces its own spend cap, and only signs the fixed-format
"paygate:<chain>:<contract>:<id>:<nonce>" message that it reconstructs from the fields.
"""
import json
import os
import sys
import time

import httpx
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3

DEFAULT_RPC = "https://rpc.mainnet.arc.io"
NONCE_PERIOD = 300
# Minimal ABI: the two functions a buyer needs.
ABI = [
    {"type": "function", "name": "quote", "stateMutability": "view",
     "inputs": [{"name": "id", "type": "uint256"}],
     "outputs": [{"name": "price", "type": "uint96"}, {"name": "window", "type": "uint32"},
                 {"name": "seller", "type": "address"}, {"name": "active", "type": "bool"},
                 {"name": "uri", "type": "string"}]},
    {"type": "function", "name": "pay", "stateMutability": "payable",
     "inputs": [{"name": "id", "type": "uint256"}, {"name": "minWindow", "type": "uint32"}],
     "outputs": [{"name": "until", "type": "uint64"}]},
]


class PayGateError(RuntimeError):
    pass


def auth_message(chain_id: int, contract: str, rid: int, nonce: int) -> str:
    return f"paygate:{chain_id}:{contract.lower()}:{rid}:{nonce}"


def validate_instructions(ins: dict, chain_id: int, pinned_contract: str | None = None) -> dict:
    """Check a 402 body against what *we* are willing to do. Raises PayGateError.
    Returns the sanitized fields {contract, rid, price, window, nonce}.
    """
    if ins.get("scheme") != "paygate-native-v1":
        raise PayGateError(f"unsupported payment scheme {ins.get('scheme')!r}")
    if ins.get("chain_id") != chain_id:
        raise PayGateError(f"server wants chain {ins.get('chain_id')}, we only pay on {chain_id}")
    contract = ins.get("contract")
    if not isinstance(contract, str) or not Web3.is_address(contract):
        raise PayGateError("malformed contract address in 402")
    contract = Web3.to_checksum_address(contract)
    if pinned_contract and Web3.to_checksum_address(pinned_contract) != contract:
        raise PayGateError(f"server names contract {contract}, we are pinned to {pinned_contract}")
    try:
        rid = int(ins["resource_id"])
        price = int(ins["price_wei"])
        window = int(ins["window_seconds"])
        nonce = int(ins["auth"]["nonce"])
        message = ins["auth"]["message"]
    except (KeyError, TypeError, ValueError) as e:
        raise PayGateError(f"malformed 402 body: {e}") from e
    if rid < 1 or price < 0 or window < 1:
        raise PayGateError("nonsensical resource id / price / window in 402")
    if abs(nonce - int(time.time() // NONCE_PERIOD)) > 1:
        raise PayGateError("server nonce is not current; refusing to pre-sign for another time bucket")
    if message != auth_message(chain_id, contract, rid, nonce):
        raise PayGateError("server asked us to sign an unexpected message; refusing")
    return {"contract": contract, "rid": rid, "price": price, "window": window, "nonce": nonce}


def auth_headers(key: str, chain_id: int, contract: str, rid: int, nonce: int) -> dict:
    acct = Account.from_key(key)
    sig = Account.sign_message(encode_defunct(text=auth_message(chain_id, contract, rid, nonce)), private_key=key)
    return {"X-PayGate-Address": acct.address, "X-PayGate-Signature": Web3.to_hex(sig.signature)}


def pay(w3: Web3, key: str, contract: str, rid: int, price: int, window: int, max_wei: int) -> str:
    """Pay `price` wei for `rid` after verifying the terms against the contract itself."""
    acct = Account.from_key(key)
    gate = w3.eth.contract(address=contract, abi=ABI)
    on_price, on_window, _seller, active, _uri = gate.functions.quote(rid).call()
    if not active:
        raise PayGateError(f"resource {rid} is inactive on-chain")
    if on_price != price:
        raise PayGateError(f"server quoted {price} wei but contract says {on_price}; refusing")
    if on_window < window:
        raise PayGateError(f"server promised {window}s but contract grants {on_window}s; refusing")
    if price > max_wei:
        raise PayGateError(f"price {price} wei exceeds PAYGATE_MAX_WEI={max_wei}")

    fn = gate.functions.pay(rid, window)  # minWindow = what we were promised
    tx = fn.build_transaction({
        "from": acct.address,
        "value": price,
        "nonce": w3.eth.get_transaction_count(acct.address),
        "maxFeePerGas": max(w3.eth.gas_price * 2, Web3.to_wei(20, "gwei")),
        "maxPriorityFeePerGas": Web3.to_wei(1, "gwei"),
    })
    h = w3.eth.send_raw_transaction(acct.sign_transaction(tx).raw_transaction)
    rcpt = w3.eth.wait_for_transaction_receipt(h, timeout=120)
    if rcpt["status"] != 1:
        raise PayGateError(f"payment tx {Web3.to_hex(h)} reverted")
    return Web3.to_hex(h)


def fetch(url: str, key: str, rpc: str = DEFAULT_RPC, chain_id: int | None = None,
          pinned_contract: str | None = None, max_wei: int | None = None, retries: int = 5) -> dict:
    chain_id = chain_id if chain_id is not None else int(os.environ.get("PAYGATE_CHAIN_ID", "5042"))
    pinned_contract = pinned_contract or os.environ.get("PAYGATE_ADDR")
    max_wei = max_wei if max_wei is not None else int(os.environ.get("PAYGATE_MAX_WEI", str(10**17)))

    r = httpx.get(url, timeout=60)
    if r.status_code == 200:
        return r.json()
    if r.status_code != 402:
        raise PayGateError(f"{r.status_code}: {r.text[:300]}")
    t = validate_instructions(r.json(), chain_id, pinned_contract)
    print(f"402: {t['price'] / 1e18:g} USDC for {t['window']}s of access (resource {t['rid']} on {t['contract']})")

    # Sign first: we may already hold access from an earlier payment.
    r = httpx.get(url, headers=auth_headers(key, chain_id, t["contract"], t["rid"], t["nonce"]), timeout=60)
    if r.status_code == 200:
        return r.json()
    if r.status_code != 402:
        # 401 = our signature was rejected, 5xx = server trouble: never pay into that.
        raise PayGateError(f"{r.status_code} after signing: {r.text[:300]}")
    # A 402 for a signed request means "no active access": the only case where paying helps.
    t = validate_instructions(r.json(), chain_id, pinned_contract)

    w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 30}))
    if w3.eth.chain_id != chain_id:
        raise PayGateError(f"RPC {rpc} is chain {w3.eth.chain_id}, expected {chain_id}")
    txh = pay(w3, key, t["contract"], t["rid"], t["price"], t["window"], max_wei)
    print(f"paid in tx {txh}")

    # Re-fetch instructions for a fresh nonce (the payment may have taken a while), then retry
    # a few times in case the server's RPC node lags our confirmation.
    for attempt in range(retries):
        r = httpx.get(url, timeout=60)
        if r.status_code == 200:
            return r.json()
        t = validate_instructions(r.json(), chain_id, pinned_contract)
        r = httpx.get(url, headers=auth_headers(key, chain_id, t["contract"], t["rid"], t["nonce"]), timeout=60)
        if r.status_code == 200:
            return r.json()
        if r.status_code != 402:
            raise PayGateError(f"{r.status_code} after paying: {r.text[:300]}")
        time.sleep(1 + attempt)
    raise PayGateError(f"paid in {txh} but server still reports no access after {retries} retries")


if __name__ == "__main__":
    if len(sys.argv) != 2 or "EVM_PRIVATE_KEY" not in os.environ:
        sys.exit(__doc__)
    try:
        out = fetch(sys.argv[1], os.environ["EVM_PRIVATE_KEY"], os.environ.get("PAYGATE_RPC", DEFAULT_RPC))
    except PayGateError as e:
        sys.exit(f"error: {e}")
    print(json.dumps(out, indent=2)[:1500])
