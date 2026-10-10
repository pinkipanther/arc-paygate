"""PayGate 402 server: sells an HTTP resource for native USDC on Arc.

Flow (x402-style):
  GET /api/<resource>            -> 402 + JSON payment instructions (chain, contract, id, price)
  GET /api/<resource>            with headers X-PayGate-Address, X-PayGate-Signature
                                 -> 200 if PayGate.hasAccess(address, id) on-chain, else 402/401

The signature is EIP-191 (personal_sign) over
    "paygate:<chain_id>:<contract>:<resource_id>:<nonce>"
so a buyer proves control of the address that paid. The message is bound to this chain and
contract so a signature cannot be replayed against another PayGate deployment, and it only ever
uses the "paygate:" prefix so a server can never trick a client into signing something else.
Nonce = floor(unix_time / 300): signatures are bearer tokens for 5-10 minutes (the server also
accepts the previous bucket). Serve over TLS so they cannot be sniffed; access is read-only so a
replayed signature only re-reads data the signer already paid for.

Run:  PAYGATE_ADDR=0x... PAYGATE_RPC=https://rpc.mainnet.arc.io python server.py
Env:  PAYGATE_CHAIN_ID (default 5042), PAYGATE_DEMO_ID (default 1), PAYGATE_SELLER (optional:
      refuse to start unless the demo resource belongs to this address), PORT (default 8402)
"""
import json
import os
import sys
import time
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3

RPC = os.environ.get("PAYGATE_RPC", "https://rpc.mainnet.arc.io")
CHAIN_ID = int(os.environ.get("PAYGATE_CHAIN_ID", "5042"))
if "PAYGATE_ADDR" not in os.environ:
    sys.exit("PAYGATE_ADDR (deployed PayGate address) is required")
ADDR = Web3.to_checksum_address(os.environ["PAYGATE_ADDR"])
PORT = int(os.environ.get("PORT", "8402"))
NONCE_PERIOD = 300
with open(os.path.join(os.path.dirname(__file__), "abi.json")) as f:
    ABI = json.load(f)

w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 15}))
gate = w3.eth.contract(address=ADDR, abi=ABI)

# resource name -> on-chain id
RESOURCES = {"polymarket-rewards": int(os.environ.get("PAYGATE_DEMO_ID", "1"))}


def polymarket_reward_screener():
    """Demo paid resource: top Polymarket liquidity-reward pools, ranked by USDC/day."""
    import httpx

    r = httpx.get("https://clob.polymarket.com/rewards/markets/current", timeout=30)
    r.raise_for_status()
    rows = sorted(r.json()["data"], key=lambda m: -m["total_daily_rate"])[:25]
    return {
        "as_of": int(time.time()),
        "pools": [
            {
                "condition_id": m["condition_id"],
                "usdc_per_day": m["total_daily_rate"],
                "min_size": m["rewards_min_size"],
                "max_spread_cents": m["rewards_max_spread"],
            }
            for m in rows
        ],
    }


PROVIDERS = {"polymarket-rewards": polymarket_reward_screener}


def nonce_now() -> int:
    return int(time.time() // NONCE_PERIOD)


def auth_message(rid: int, nonce: int) -> str:
    return f"paygate:{CHAIN_ID}:{ADDR.lower()}:{rid}:{nonce}"


def signature_matches(rid: int, addr: str, sig: str) -> bool:
    """True if `sig` over the current or previous nonce bucket recovers to `addr` (checksummed)."""
    now = nonce_now()
    for n in (now, now - 1):
        try:
            signer = Account.recover_message(encode_defunct(text=auth_message(rid, n)), signature=sig)
        except Exception:  # noqa: BLE001 - malformed signature
            return False
        if signer == addr:
            return True
    return False


_quote_cache: dict = {}
QUOTE_TTL = 5.0  # seconds; bounds RPC load from unauthenticated 402 probes


def cached_quote(rid: int):
    hit = _quote_cache.get(rid)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    q = gate.functions.quote(rid).call()
    _quote_cache[rid] = (time.monotonic() + QUOTE_TTL, q)
    return q


def looks_like_signature(sig: str) -> bool:
    h = sig[2:] if sig.startswith("0x") else sig
    return len(h) == 130 and all(c in "0123456789abcdefABCDEF" for c in h)


class H(BaseHTTPRequestHandler):
    server_version = "PayGate/1"

    def _json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        try:
            self._get()
        except Exception as e:  # noqa: BLE001 - never drop the connection without a JSON body
            self.log_error("unhandled: %r", e)
            self._json(502, {"error": "upstream error"})

    def _get(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return self._json(200, {"ok": True, "paygate": ADDR, "chain_id": CHAIN_ID, "resources": list(RESOURCES)})
        name = path[len("/api/") :]
        if name not in RESOURCES:
            return self._json(404, {"error": "unknown resource"})
        rid = RESOURCES[name]

        # Cheap syntactic checks first so garbage credentials never cost an RPC call.
        addr = self.headers.get("X-PayGate-Address")
        sig = self.headers.get("X-PayGate-Signature")
        if addr or sig:
            if not (addr and sig):
                return self._json(400, {"error": "both X-PayGate-Address and X-PayGate-Signature are required"})
            if not Web3.is_address(addr):
                return self._json(400, {"error": "malformed X-PayGate-Address"})
            if not looks_like_signature(sig):
                return self._json(400, {"error": "malformed X-PayGate-Signature"})
            addr = Web3.to_checksum_address(addr)

        price, window, seller, active, uri = cached_quote(rid)
        if int(seller, 16) == 0:
            return self._json(404, {"error": "resource does not exist on-chain"})
        if not active:
            # Do not hand out payment instructions the contract would reject.
            return self._json(503, {"error": "resource is not for sale right now"})
        nonce = nonce_now()
        instructions = {
            "scheme": "paygate-native-v1",
            "chain_id": CHAIN_ID,
            "contract": ADDR,
            "resource_id": rid,
            "price_wei": str(price),
            "price_usdc": str(Decimal(price) / Decimal(10**18)),
            "window_seconds": window,
            "pay_calldata": gate.encode_abi("pay", [rid, window]),  # pay(id, minWindow)
            "auth": {
                "header_address": "X-PayGate-Address",
                "header_signature": "X-PayGate-Signature",
                "message_format": "paygate:<chain_id>:<contract_lowercase>:<resource_id>:<floor(unix/300)>",
                "nonce": nonce,
                "message": auth_message(rid, nonce),
            },
        }

        if not addr:
            return self._json(402, {"error": "payment required", **instructions})
        if not signature_matches(rid, addr, sig):
            return self._json(401, {"error": "bad signature", "expected_message": instructions["auth"]["message"]})

        if not gate.functions.hasAccess(addr, rid).call():
            return self._json(402, {"error": "no active access for this address", **instructions})
        until = gate.functions.accessUntil(addr, rid).call()
        return self._json(200, {"resource": name, "access_until": until, "data": PROVIDERS[name]()})


def main():
    chain = w3.eth.chain_id
    if chain != CHAIN_ID:
        sys.exit(f"RPC {RPC} is chain {chain}, expected PAYGATE_CHAIN_ID={CHAIN_ID}")
    if len(w3.eth.get_code(ADDR)) == 0:
        sys.exit(f"no contract code at PAYGATE_ADDR={ADDR} on chain {chain}")
    for name, rid in RESOURCES.items():
        price, window, seller, active, uri = gate.functions.quote(rid).call()
        if int(seller, 16) == 0:
            sys.exit(f"resource {rid} ({name}) does not exist on {ADDR}")
        want = os.environ.get("PAYGATE_SELLER")
        if want and Web3.to_checksum_address(want) != seller:
            sys.exit(f"resource {rid} is owned by {seller}, not PAYGATE_SELLER={want}")
        print(f"  {name}: id={rid} price={Decimal(price) / Decimal(10**18)} USDC window={window}s "
              f"seller={seller} active={active}")
    print(f"PayGate server on :{PORT} -> {ADDR} @ {RPC} (chain {CHAIN_ID})")
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()


if __name__ == "__main__":
    main()
