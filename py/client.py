"""Agent-side PayGate client: discover, quote and fetch resources, paying on Arc in native USDC.

Usage:
  python client.py quote    <url> [--json]          price and terms, verified on-chain (no key needed)
  python client.py fetch    <url> [--max-usdc 0.1]  fetch, paying first if needed (key: EVM_PRIVATE_KEY or --key-file)
  python client.py discover <base-url> [--json]     what a server sells (/.well-known/paygate.json)
  python client.py <url>                            same as `fetch <url>` (legacy form)

Options: --contract (PAYGATE_ADDR; fetch refuses to pay without it unless --allow-any-contract),
         --rpc (PAYGATE_RPC, default Arc mainnet), --chain-id (PAYGATE_CHAIN_ID, default 5042),
         --resource-id (pin the on-chain id too), --max-usdc (PAYGATE_MAX_USDC, default 0.1; the
         legacy PAYGATE_MAX_WEI is still read), --max-fee-usdc (worst-case gas, default 0.01),
         --out FILE, --retries N, --allow-http (plain http to a non-loopback host)

Trust model: the 402 body is *untrusted*. The client never sends server-supplied calldata and
never signs server-supplied text. It pays only the contract it is pinned to, reads the quote from
the contract itself, simulates `pay(id, minWindow)` locally before broadcasting, caps both the
price and the worst-case gas fee, re-checks on-chain access under a per-(payer, resource) lock so
concurrent runs never pay twice, and signs only the fixed-format message
    paygate:2:<chain_id>:<contract_lowercase>:<resource_id>:<nonce>:<host_lowercase>
that it rebuilds from the URL it actually requested (so a phishing host can only ever collect a
signature bound to itself, which the real server rejects).
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import ipaddress
import json
import os
import re
import sys
import threading
import time
from decimal import Decimal, InvalidOperation, localcontext
from urllib.parse import urljoin, urlsplit

import httpx
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3
from web3.exceptions import TimeExhausted

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows: in-process lock only
    fcntl = None

DEFAULT_RPC = "https://rpc.mainnet.arc.io"
DEFAULT_CHAIN_ID = 5042
SCHEME = "paygate-native-v2"
X402_SCHEME = "exact-native"
WELL_KNOWN = "/.well-known/paygate.json"
NONCE_PERIOD = 300
WEI_PER_USDC = 10**18
DEFAULT_MAX_WEI = 10**17          # 0.1 USDC per payment
DEFAULT_MAX_FEE_WEI = 10**16      # 0.01 USDC worst-case gas per payment
MAX_RESPONSE_BYTES = 8 * 2**20    # refuse larger responses instead of buffering them
SKIP_PAY_IF_REMAINING = 60        # seconds of on-chain access that make paying again pointless
MAX_RETRY_AFTER = 30
LOCK_WAIT = 300
UINT32_MAX = 2**32 - 1

# Minimal ABI: what a buyer needs.
ABI = [
    {"type": "function", "name": "quote", "stateMutability": "view",
     "inputs": [{"name": "id", "type": "uint256"}],
     "outputs": [{"name": "price", "type": "uint96"}, {"name": "window", "type": "uint32"},
                 {"name": "seller", "type": "address"}, {"name": "active", "type": "bool"},
                 {"name": "uri", "type": "string"}]},
    {"type": "function", "name": "pay", "stateMutability": "payable",
     "inputs": [{"name": "id", "type": "uint256"}, {"name": "minWindow", "type": "uint32"}],
     "outputs": [{"name": "until", "type": "uint64"}]},
    {"type": "function", "name": "remaining", "stateMutability": "view",
     "inputs": [{"name": "who", "type": "address"}, {"name": "id", "type": "uint256"}],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "accessUntil", "stateMutability": "view",
     "inputs": [{"name": "", "type": "address"}, {"name": "", "type": "uint256"}],
     "outputs": [{"name": "", "type": "uint64"}]},
]

_CTRL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_HOSTNAME_RE = re.compile(r"[a-z0-9]([a-z0-9.\-_]*[a-z0-9])?|\[[0-9a-f:.]+\]")
_PATH_RE = re.compile(r"/(?!/)[A-Za-z0-9._~\-/]*")


class PayGateError(RuntimeError):
    pass


def _stderr(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _excerpt(text, n: int = 300) -> str:
    """Server-controlled text, made safe for terminals and logs."""
    return _CTRL.sub("?", str(text)[:n])


# ----------------------------------------------------------------------------- amounts

def parse_usdc(text) -> int:
    """'0.05' -> 5e16 wei, exactly. Raises ValueError for negatives, NaN or > 18 decimals."""
    try:
        d = Decimal(str(text).strip())
    except InvalidOperation:
        raise ValueError(f"not a USDC amount: {text!r}") from None
    if not d.is_finite() or d < 0:
        raise ValueError(f"not a non-negative USDC amount: {text!r}")
    with localcontext() as ctx:
        ctx.prec = 100
        wei = d.scaleb(18)
    if wei != wei.to_integral_value():
        raise ValueError(f"{text!r} has more than 18 decimal places")
    return int(wei)


def format_usdc(wei: int) -> str:
    whole, frac = divmod(int(wei), WEI_PER_USDC)
    return f"{whole}.{frac:018d}".rstrip("0") if frac else str(whole)


# ----------------------------------------------------------------------------- protocol

def current_nonce() -> int:
    return int(time.time() // NONCE_PERIOD)


def auth_message(chain_id: int, contract: str, rid: int, nonce: int, host: str) -> str:
    return f"paygate:2:{chain_id}:{contract.lower()}:{rid}:{nonce}:{host.lower()}"


def url_host(url: str) -> str:
    """The host as it goes into the signed message: lowercase (IDNA for unicode names), IPv6
    in brackets, plus ':port' only when it is not the scheme default."""
    try:
        p = urlsplit(url)
        scheme = (p.scheme or "").lower()
        host, port = p.hostname, p.port
    except ValueError as e:
        raise PayGateError(f"bad URL: {e}") from None
    if scheme not in ("http", "https"):
        raise PayGateError(f"unsupported URL scheme {scheme!r}")
    if not host:
        raise PayGateError("URL has no host")
    try:
        host = host.encode("idna").decode("ascii").lower() if not host.isascii() else host.lower()
    except UnicodeError:
        raise PayGateError("URL host is not a valid hostname") from None
    if ":" in host:
        host = f"[{host}]"
    if not _HOSTNAME_RE.fullmatch(host):
        raise PayGateError("URL host is not a valid hostname")
    return f"{host}:{port}" if port is not None and port != (443 if scheme == "https" else 80) else host


def _is_loopback(hostname: str | None) -> bool:
    if not hostname:
        return False
    if hostname.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def check_url(url: str, allow_http: bool = False) -> str:
    """Validate a URL we are about to send a signature to; returns its signing host."""
    host = url_host(url)
    p = urlsplit(url)
    if p.username or p.password:
        raise PayGateError("credentials in the URL are not supported")
    if p.scheme.lower() == "http" and not allow_http and not _is_loopback(p.hostname):
        raise PayGateError("refusing to send a signature over plain http to a non-loopback host "
                           "(use https, or --allow-http)")
    return host


def _strict_int(v, what: str) -> int:
    if isinstance(v, bool):
        raise PayGateError(f"malformed {what} in 402")
    if isinstance(v, int):
        return v
    if isinstance(v, str) and re.fullmatch(r"[0-9]{1,78}", v):
        return int(v)
    raise PayGateError(f"malformed {what} in 402")


def validate_instructions(ins, chain_id: int, pinned_contract: str | None = None, *, host: str,
                          pinned_rid: int | None = None) -> dict:
    """Check a 402 body against what *we* are willing to do. Raises PayGateError.
    Returns the sanitized fields {contract, rid, price, window, nonce, skew, host}; `nonce` is
    the bucket to sign (never later than our own clock)."""
    t = validate_auth(ins, chain_id, pinned_contract, host=host, pinned_rid=pinned_rid)
    price = _strict_int(ins.get("price_wei"), "price_wei")
    window = _strict_int(ins.get("window_seconds"), "window_seconds")
    if price < 0 or window < 1 or window > UINT32_MAX:
        raise PayGateError("nonsensical price / window in 402")
    return {**t, "price": price, "window": window}


def validate_auth(ins, chain_id: int, pinned_contract: str | None = None, *, host: str,
                  pinned_rid: int | None = None) -> dict:
    """The part of a 402/503 body that says what to sign: gate identity, resource, nonce and the
    exact message, which must equal the one we rebuild for `host`. Raises PayGateError."""
    if not isinstance(ins, dict):
        raise PayGateError("402 body is not a JSON object")
    if ins.get("scheme") != SCHEME:
        raise PayGateError(f"unsupported payment scheme {_excerpt(ins.get('scheme'), 60)!r}")
    if type(ins.get("chain_id")) is not int or ins["chain_id"] != chain_id:
        raise PayGateError(f"server wants chain {_excerpt(ins.get('chain_id'), 40)}, we only pay on {chain_id}")
    contract = ins.get("contract")
    if not isinstance(contract, str) or not Web3.is_address(contract):
        raise PayGateError("malformed contract address in 402")
    contract = Web3.to_checksum_address(contract)
    if pinned_contract and Web3.to_checksum_address(pinned_contract) != contract:
        raise PayGateError(f"server names contract {contract}, we are pinned to {pinned_contract}")
    rid = _strict_int(ins.get("resource_id"), "resource_id")
    auth = ins.get("auth")
    if not isinstance(auth, dict):
        raise PayGateError("malformed auth block in 402")
    nonce = _strict_int(auth.get("nonce"), "auth.nonce")
    if rid < 1:
        raise PayGateError("nonsensical resource id in 402")
    if pinned_rid is not None and rid != pinned_rid:
        raise PayGateError(f"server names resource {rid}, we are pinned to {pinned_rid}")
    local = current_nonce()
    if abs(nonce - local) > 1:
        raise PayGateError("server nonce is not current; refusing to pre-sign for another time bucket")
    if auth.get("message") != auth_message(chain_id, contract, rid, nonce, host):
        raise PayGateError("server asked us to sign an unexpected message (wrong host, contract or format); refusing")
    return {"contract": contract, "rid": rid, "nonce": min(nonce, local), "skew": nonce - local, "host": host}


def _sign(key: str, chain_id: int, contract: str, rid: int, nonce: int, host: str) -> tuple[str, str]:
    acct = Account.from_key(key)
    msg = encode_defunct(text=auth_message(chain_id, contract, rid, nonce, host))
    return acct.address, Web3.to_hex(Account.sign_message(msg, private_key=key).signature)


def auth_headers(key: str, chain_id: int, contract: str, rid: int, nonce: int, host: str) -> dict:
    addr, sig = _sign(key, chain_id, contract, rid, nonce, host)
    return {"X-PayGate-Address": addr, "X-PayGate-Signature": sig}


def x_payment_header(key: str, chain_id: int, contract: str, rid: int, nonce: int, host: str) -> dict:
    """The same proof in x402-shaped form: X-PAYMENT = base64(JSON)."""
    addr, sig = _sign(key, chain_id, contract, rid, nonce, host)
    body = {"x402Version": 1, "scheme": X402_SCHEME, "network": f"eip155:{chain_id}",
            "payload": {"from": addr, "signature": sig, "nonce": nonce}}
    return {"X-PAYMENT": base64.b64encode(json.dumps(body, separators=(",", ":")).encode()).decode()}


def decode_payment_response(value: str) -> dict:
    return json.loads(base64.b64decode(value, validate=True))


# ----------------------------------------------------------------------------- HTTP

class _Http:
    """httpx without redirects, with a response-size cap, and polite (bounded) 429 handling."""

    def __init__(self, max_bytes: int = MAX_RESPONSE_BYTES, timeout: float = 30.0, log=_stderr, max_429: int = 3):
        self.max_bytes, self.log, self.max_429 = max_bytes, log, max_429
        self._c = httpx.Client(timeout=timeout, follow_redirects=False)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self._c.close()

    def get(self, url: str, headers: dict | None = None):
        """-> (status, parsed JSON or None, text, headers)."""
        for attempt in range(self.max_429 + 1):
            try:
                with self._c.stream("GET", url, headers=headers) as r:
                    cl = r.headers.get("content-length", "")
                    if cl.isdigit() and int(cl) > self.max_bytes:
                        raise PayGateError(f"response of {cl} bytes exceeds the {self.max_bytes}-byte limit")
                    buf = bytearray()
                    for chunk in r.iter_bytes():
                        buf += chunk
                        if len(buf) > self.max_bytes:
                            raise PayGateError(f"response exceeds the {self.max_bytes}-byte limit; refusing")
                    status, hdrs = r.status_code, r.headers
            except httpx.HTTPError as e:
                raise PayGateError(f"HTTP error talking to {url}: {_excerpt(e, 200)}") from None
            if status == 429 and attempt < self.max_429:
                ra = hdrs.get("retry-after", "1")
                wait = min(MAX_RETRY_AFTER, max(0.5, float(ra) if ra.isdigit() else 1.0))
                self.log(f"rate limited by the server; retrying in {wait:g}s")
                time.sleep(wait)
                continue
            break
        text = buf.decode("utf-8", "replace")
        try:
            body = json.loads(text)
        except ValueError:
            body = None
        return status, body, text, hdrs


def _error_text(status: int, body, text: str) -> str:
    detail = body.get("error") if isinstance(body, dict) else text
    return f"{status}: {_excerpt(detail)}"


def _ok(body, text: str) -> dict:
    if not isinstance(body, dict):
        raise PayGateError(f"server returned a non-JSON 200: {_excerpt(text, 120)}")
    return body


# ----------------------------------------------------------------------------- chain

def _web3(rpc: str, chain_id: int) -> Web3:
    w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 30}))
    actual = w3.eth.chain_id
    if actual != chain_id:
        raise PayGateError(f"RPC is chain {actual}, expected {chain_id}")
    return w3


def onchain_remaining(w3: Web3, contract: str, who: str, rid: int) -> int:
    """Seconds of access `who` holds on-chain (v2 `remaining`; falls back to accessUntil vs the
    latest block for pre-v2 deployments)."""
    gate = w3.eth.contract(address=contract, abi=ABI)
    try:
        return int(gate.functions.remaining(who, rid).call())
    except Exception:  # noqa: BLE001 - v1 contract without remaining()
        until = int(gate.functions.accessUntil(who, rid).call())
        return max(0, until - int(w3.eth.get_block("latest")["timestamp"]))


def pay(w3: Web3, key: str, contract: str, rid: int, price: int, window: int, max_wei: int, *,
        max_fee_wei: int = DEFAULT_MAX_FEE_WEI, chain_id: int | None = None, receipt_timeout: int = 120) -> str:
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
        raise PayGateError(f"price {format_usdc(price)} USDC exceeds the spend cap of {format_usdc(max_wei)} USDC")

    fn = gate.functions.pay(rid, window)  # minWindow = what we were promised
    # Simulate first: a payment that would revert (paused, repriced, short window, no funds)
    # is refused before it costs gas.
    try:
        fn.call({"from": acct.address, "value": price})
    except Exception as e:  # noqa: BLE001
        raise PayGateError(f"payment simulation failed, not broadcasting: {_excerpt(e, 200)}") from None
    params = {
        "from": acct.address,
        "value": price,
        # 'latest', not 'pending', on purpose: if an earlier payment is stuck in the mempool, this
        # one reuses its nonce and replaces it instead of becoming a second payment.
        "nonce": w3.eth.get_transaction_count(acct.address),
        "maxFeePerGas": max(w3.eth.gas_price * 2, Web3.to_wei(20, "gwei")),
        "maxPriorityFeePerGas": Web3.to_wei(1, "gwei"),
    }
    if chain_id is not None:
        params["chainId"] = chain_id  # EIP-155: the signed tx is only valid on the chain we pinned
    try:
        tx = fn.build_transaction(params)
    except Exception as e:  # noqa: BLE001
        raise PayGateError(f"could not build the payment tx: {_excerpt(e, 200)}") from None
    worst_fee = tx["gas"] * tx["maxFeePerGas"]
    if worst_fee > max_fee_wei:
        raise PayGateError(f"worst-case gas fee {format_usdc(worst_fee)} USDC exceeds the fee cap of "
                           f"{format_usdc(max_fee_wei)} USDC")
    h = w3.eth.send_raw_transaction(acct.sign_transaction(tx).raw_transaction)
    try:
        rcpt = w3.eth.wait_for_transaction_receipt(h, timeout=receipt_timeout)
    except TimeExhausted:
        raise PayGateError(f"payment tx {Web3.to_hex(h)} not mined within {receipt_timeout}s; re-running is "
                           "safe (the client checks on-chain access, and reuses the nonce, before paying)") from None
    if rcpt["status"] != 1:
        raise PayGateError(f"payment tx {Web3.to_hex(h)} reverted")
    return Web3.to_hex(h)


_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def default_lock_dir() -> str:
    return os.environ.get("PAYGATE_LOCK_DIR") or os.path.join(os.path.expanduser("~"), ".cache", "paygate", "locks")


@contextlib.contextmanager
def payment_lock(chain_id: int, contract: str, rid: int, payer: str, lock_dir: str | None = None,
                 wait: float = LOCK_WAIT):
    """Serialize payments per (chain, contract, resource, payer) across threads (in-process lock)
    and processes (flock on a per-user lock file), so a concurrent fetch re-checks on-chain
    access after the first payment instead of paying again."""
    name = hashlib.sha256(f"{chain_id}:{contract.lower()}:{rid}:{payer.lower()}".encode()).hexdigest()[:32]
    with _LOCKS_GUARD:
        lk = _LOCKS.setdefault(name, threading.Lock())
    if not lk.acquire(timeout=wait):
        raise PayGateError("another payment for this resource is still in progress")
    fd = None
    try:
        if fcntl is not None:
            d = lock_dir or default_lock_dir()
            os.makedirs(d, mode=0o700, exist_ok=True)
            fd = os.open(os.path.join(d, name + ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
            deadline = time.monotonic() + wait
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() > deadline:
                        raise PayGateError("another process is paying for this resource; gave up waiting") from None
                    time.sleep(0.1)
        yield
    finally:
        if fd is not None:
            os.close(fd)  # releases the flock
        lk.release()


# ----------------------------------------------------------------------------- high level

def _defaults(chain_id, pinned_contract, max_wei):
    chain_id = chain_id if chain_id is not None else int(os.environ.get("PAYGATE_CHAIN_ID", DEFAULT_CHAIN_ID))
    pinned_contract = pinned_contract or os.environ.get("PAYGATE_ADDR") or None
    if max_wei is None:
        if os.environ.get("PAYGATE_MAX_USDC"):
            max_wei = parse_usdc(os.environ["PAYGATE_MAX_USDC"])
        else:
            max_wei = int(os.environ.get("PAYGATE_MAX_WEI", DEFAULT_MAX_WEI))
    return chain_id, pinned_contract, max_wei


def fetch(url: str, key: str, rpc: str = DEFAULT_RPC, chain_id: int | None = None,
          pinned_contract: str | None = None, max_wei: int | None = None, retries: int = 5, *,
          allow_any_contract: bool = False, max_fee_wei: int | None = None, pinned_rid: int | None = None,
          allow_http: bool = False, backoff: float = 1.0, lock_dir: str | None = None,
          max_response_bytes: int = MAX_RESPONSE_BYTES, log=_stderr) -> dict:
    """GET `url`; if it is paywalled, prove/obtain access and return the JSON body."""
    chain_id, pinned_contract, max_wei = _defaults(chain_id, pinned_contract, max_wei)
    max_fee_wei = DEFAULT_MAX_FEE_WEI if max_fee_wei is None else max_fee_wei
    if not pinned_contract and not allow_any_contract:
        raise PayGateError("no PayGate contract pinned: set PAYGATE_ADDR or --contract "
                           "(or --allow-any-contract to let the server choose, bounded by the spend cap)")
    host = check_url(url, allow_http)
    me = Account.from_key(key).address

    with _Http(max_response_bytes, log=log) as http:
        st, body, text, _ = http.get(url)
        if st == 200:
            return _ok(body, text)
        if st == 503 and isinstance(body, dict) and "auth" in body:
            # Not for sale (paused): access bought earlier is still honoured, so prove it, but
            # never pay here.
            t = validate_auth(body, chain_id, pinned_contract, host=host, pinned_rid=pinned_rid)
            hdr = auth_headers(key, chain_id, t["contract"], t["rid"], t["nonce"], host)
            st2, body2, text2, _ = http.get(url, hdr)
            if st2 == 200:
                return _ok(body2, text2)
            raise PayGateError(f"{_error_text(st, body, text)} (and {me} holds no access)")
        if st != 402:
            raise PayGateError(_error_text(st, body, text))
        t = validate_instructions(body, chain_id, pinned_contract, host=host, pinned_rid=pinned_rid)
        log(f"402: {format_usdc(t['price'])} USDC for {t['window']}s of access "
            f"(resource {t['rid']} on {t['contract']}, host {host})")
        skew = min(t["skew"], 0)

        def signed_get():
            hdr = auth_headers(key, chain_id, t["contract"], t["rid"], current_nonce() + skew, host)
            return http.get(url, hdr)

        # Sign first: we may already hold access from an earlier payment.
        st, body, text, _ = signed_get()
        if st == 200:
            return _ok(body, text)
        if st != 402:
            # 401 = our signature was rejected, 5xx = server trouble: never pay into that.
            raise PayGateError(f"{_error_text(st, body, text)} (after signing; not paying)")
        # A 402 for a signed request means "no active access": the only case where paying helps.
        t2 = validate_instructions(body, chain_id, pinned_contract, host=host, pinned_rid=pinned_rid)
        if (t2["contract"], t2["rid"]) != (t["contract"], t["rid"]):
            raise PayGateError("server changed the contract or resource between requests; refusing")
        t = {**t2, "skew": t["skew"]}

        w3 = _web3(rpc, chain_id)
        txh = None
        with payment_lock(chain_id, t["contract"], t["rid"], me, lock_dir):
            rem = onchain_remaining(w3, t["contract"], me, t["rid"])
            if rem >= SKIP_PAY_IF_REMAINING:
                log(f"{me} already holds {rem}s of on-chain access; not paying again")
            else:
                txh = pay(w3, key, t["contract"], t["rid"], t["price"], t["window"], max_wei,
                          max_fee_wei=max_fee_wei, chain_id=chain_id)
                log(f"paid in tx {txh}")

        # Retry in case the server's RPC node lags our confirmation. Signing with our own clock
        # (adjusted for the skew seen above) needs no extra unauthenticated round trip, and still
        # works if the resource was paused after we paid.
        for attempt in range(retries):
            st, body, text, _ = signed_get()
            if st == 200:
                return _ok(body, text)
            not_yet = st == 402 or (st == 503 and isinstance(body, dict) and "auth" in body)  # paused meanwhile
            if not not_yet:
                raise PayGateError(f"{_error_text(st, body, text)} while waiting for the server to see our access")
            time.sleep(backoff * (1 + attempt))
    if txh:
        raise PayGateError(f"paid in {txh} but the server still reports no access after {retries} retries; "
                           "access is on-chain, re-run later (it will not pay again)")
    raise PayGateError(f"{me} holds on-chain access but the server did not honour it after {retries} retries")


def quote(url: str, rpc: str = DEFAULT_RPC, chain_id: int | None = None, pinned_contract: str | None = None, *,
          who: str | None = None, pinned_rid: int | None = None, max_response_bytes: int = MAX_RESPONSE_BYTES,
          log=_stderr) -> dict:
    """Read a resource's 402 and verify its terms on-chain. Sends no signature, needs no key."""
    chain_id, pinned_contract, _ = _defaults(chain_id, pinned_contract, 0)
    host = url_host(url)
    with _Http(max_response_bytes, log=log) as http:
        st, body, text, _ = http.get(url)
    if st == 200:
        return {"url": url, "free": True}
    if st != 402:
        raise PayGateError(_error_text(st, body, text))
    t = validate_instructions(body, chain_id, pinned_contract, host=host, pinned_rid=pinned_rid)
    w3 = _web3(rpc, chain_id)
    gate = w3.eth.contract(address=t["contract"], abi=ABI)
    price, window, seller, active, uri = gate.functions.quote(t["rid"]).call()
    out = {
        "url": url,
        "host": host,
        "chain_id": chain_id,
        "contract": t["contract"],
        "pinned": bool(pinned_contract),
        "resource_id": t["rid"],
        "price_wei": str(price),
        "price_usdc": format_usdc(price),
        "window_seconds": int(window),
        "active": bool(active),
        "seller": Web3.to_checksum_address(seller),
        "uri": _excerpt(uri, 512),
        "server_price_wei": str(t["price"]),
        "server_window_seconds": t["window"],
        "matches_chain": bool(active) and int(price) == t["price"] and int(window) >= t["window"],
    }
    if who:
        out["address"] = Web3.to_checksum_address(who)
        out["remaining_seconds"] = onchain_remaining(w3, t["contract"], out["address"], t["rid"])
    return out


def discover(base_url: str, *, max_response_bytes: int = MAX_RESPONSE_BYTES, log=_stderr) -> dict:
    """Fetch /.well-known/paygate.json. The document is untrusted: it only tells you where to
    look; `quote`/`fetch` verify everything on-chain. Resource URLs are rebuilt from `base_url`
    and a validated path, never taken from the document, so it cannot point you at another host."""
    url_host(base_url)
    url = urljoin(base_url if base_url.endswith("/") else base_url + "/", WELL_KNOWN.lstrip("/"))
    with _Http(max_response_bytes, log=log) as http:
        st, body, text, _ = http.get(url)
    if st != 200 or not isinstance(body, dict) or not isinstance(body.get("resources"), list):
        raise PayGateError(f"no PayGate discovery document at {url} ({_error_text(st, body, text)})")
    resources = []
    for r in body["resources"]:
        if not isinstance(r, dict) or not isinstance(r.get("path"), str) or not _PATH_RE.fullmatch(r["path"]):
            continue
        resources.append({
            "name": _excerpt(r.get("name", ""), 80),
            "url": urljoin(url, r["path"]),
            "resource_id": r.get("resource_id"),
            "price_usdc": _excerpt(r.get("price_usdc", ""), 40),
            "window_seconds": r.get("window_seconds"),
            "for_sale": r.get("for_sale"),
        })
    return {"url": url, "scheme": body.get("scheme"), "chain_id": body.get("chain_id"),
            "contract": body.get("contract"), "resources": resources}


# ----------------------------------------------------------------------------- CLI

def _usdc_arg(text: str) -> int:
    try:
        return parse_usdc(text)
    except ValueError as e:
        raise argparse.ArgumentTypeError(str(e)) from None


def _load_key(args) -> str:
    if args.key_file:
        with open(args.key_file) as f:
            return f.read().strip()
    key = os.environ.get("EVM_PRIVATE_KEY")
    if not key:
        raise PayGateError("no key: set EVM_PRIVATE_KEY or pass --key-file (keys are never taken as arguments)")
    return key


def _print_quote(q: dict) -> None:
    if q.get("free"):
        print(f"{q['url']} is served without payment")
        return
    print(f"resource {q['resource_id']} at {q['url']}")
    print(f"  contract  {q['contract']} (chain {q['chain_id']}){'' if q['pinned'] else '  [NOT pinned]'}")
    print(f"  price     {q['price_usdc']} USDC ({q['price_wei']} wei), read on-chain")
    print(f"  window    {q['window_seconds']} s per payment")
    print(f"  for sale  {'yes' if q['active'] else 'no'}")
    if not q["matches_chain"]:
        print(f"  WARNING   server quoted {q['server_price_wei']} wei / {q['server_window_seconds']} s; "
              "the chain disagrees (or the resource is paused)")
    if "remaining_seconds" in q:
        print(f"  access    {q['remaining_seconds']} s remaining for {q['address']}")


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and "://" in argv[0]:
        argv = ["fetch", *argv]  # legacy: client.py <url>
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--rpc", default=os.environ.get("PAYGATE_RPC", DEFAULT_RPC), help="RPC URL (PAYGATE_RPC)")
    common.add_argument("--chain-id", type=int, default=int(os.environ.get("PAYGATE_CHAIN_ID", DEFAULT_CHAIN_ID)))
    common.add_argument("--contract", default=os.environ.get("PAYGATE_ADDR"), help="pinned PayGate (PAYGATE_ADDR)")
    common.add_argument("--resource-id", type=int, help="also pin the on-chain resource id")
    common.add_argument("--json", action="store_true", help="machine-readable output")
    p = argparse.ArgumentParser(prog="client.py", description="PayGate buyer: quote, fetch and discover paywalled APIs")
    sub = p.add_subparsers(dest="cmd", required=True)
    q = sub.add_parser("quote", parents=[common], help="show a resource's price, verified on-chain")
    q.add_argument("url")
    q.add_argument("--address", help="also show this address's remaining access (default: EVM_PRIVATE_KEY's)")
    f = sub.add_parser("fetch", parents=[common], help="fetch a resource, paying first if needed")
    f.add_argument("url")
    f.add_argument("--max-usdc", type=_usdc_arg, help="spend cap per payment in USDC (PAYGATE_MAX_USDC, default 0.1)")
    f.add_argument("--max-fee-usdc", type=_usdc_arg, default=DEFAULT_MAX_FEE_WEI,
                   help="cap on the worst-case gas fee in USDC (default 0.01)")
    f.add_argument("--key-file", help="file holding the buyer's private key (else EVM_PRIVATE_KEY)")
    f.add_argument("--out", help="write the response JSON here instead of stdout")
    f.add_argument("--retries", type=int, default=5)
    f.add_argument("--allow-http", action="store_true", help="allow plain http to a non-loopback host")
    f.add_argument("--allow-any-contract", action="store_true",
                   help="pay whichever contract the server names (still capped); default is to require --contract")
    d = sub.add_parser("discover", parents=[common], help="list what a server sells")
    d.add_argument("base_url")
    args = p.parse_args(argv)

    try:
        if args.cmd == "quote":
            who = args.address
            if not who and os.environ.get("EVM_PRIVATE_KEY"):
                who = Account.from_key(os.environ["EVM_PRIVATE_KEY"]).address
            res = quote(args.url, args.rpc, args.chain_id, args.contract, who=who, pinned_rid=args.resource_id)
            print(json.dumps(res, indent=2)) if args.json else _print_quote(res)
            return 0 if res.get("free") or res["matches_chain"] else 1
        if args.cmd == "discover":
            res = discover(args.base_url)
            if args.json:
                print(json.dumps(res, indent=2))
            else:
                print(f"{res['url']}: chain {res['chain_id']}, contract {res['contract']} (unverified; use quote)")
                for r in res["resources"]:
                    print(f"  {r['url']}  id={r['resource_id']}  {r['price_usdc']} USDC / {r['window_seconds']}s"
                          f"{'' if r['for_sale'] else '  (not for sale)'}")
            return 0
        key = _load_key(args)
        out = fetch(args.url, key, args.rpc, args.chain_id, args.contract, args.max_usdc, args.retries,
                    allow_any_contract=args.allow_any_contract, max_fee_wei=args.max_fee_usdc,
                    pinned_rid=args.resource_id, allow_http=args.allow_http)
        text = json.dumps(out, indent=2)
        if args.out:
            with open(args.out, "w") as fh:
                fh.write(text + "\n")
            _stderr(f"wrote {args.out}")
        else:
            print(text)
        return 0
    except PayGateError as e:
        _stderr(f"error: {e}")
        return 1
    except Exception as e:  # noqa: BLE001 - RPC/network failures: one line, no traceback
        _stderr(f"error: {type(e).__name__}: {_excerpt(e, 300)}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
