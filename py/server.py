"""PayGate 402 server: sells an HTTP resource for native USDC on Arc.

Flow (x402-shaped, native scheme):
  GET /.well-known/paygate.json  -> discovery: chain, contract, message format, resources
  GET /api/<resource>            -> 402 + payment requirements (paygate fields + x402 `accepts`)
  GET /api/<resource>            with X-PayGate-Address + X-PayGate-Signature, or X-PAYMENT
                                 -> 200 if PayGate.remaining(address, id) > 0 on-chain, else 402/401

The signature is EIP-191 (personal_sign) over
    "paygate:2:<chain_id>:<contract_lowercase>:<resource_id>:<nonce>:<host_lowercase>"
so a buyer proves control of the address that paid. The message is bound to this chain, contract,
resource and *server host*: a phishing server that relays a genuine 402 still collects a signature
for its own host, which this server rejects. The host is PAYGATE_PUBLIC_HOST; without it, only a
loopback Host header (local development) is accepted and anything else gets 421. Only the
"paygate:" prefix is ever signed, so a server can never trick a client into signing something else.
Nonce = floor(unix_time / 300): signatures are bearer tokens for 5-10 minutes (the server also
accepts the previous bucket). Serve over TLS. See SECURITY.md.

x402 compatibility: the 402 also carries an x402-style envelope (x402Version, accepts[]) with the
non-standard scheme name "exact-native" (a direct native-USDC `pay()` call, not EIP-3009), and the
server accepts the same signature in an `X-PAYMENT` header (base64 JSON). It is x402-shaped, not a
registered x402 scheme: generic x402 facilitators will not settle it.

Access is decided by the chain alone (PayGate v2 `remaining`, exclusive at expiry: a payment at
time t with window w is honoured for t <= now < t + w). Pausing a resource stops new sales but
buyers with live access keep being served, matching the contract.

Run:  PAYGATE_ADDR=0x... PAYGATE_PUBLIC_HOST=api.example.com python server.py [--json]
Env:  PAYGATE_ADDR (required), PAYGATE_RPC, PAYGATE_CHAIN_ID (5042), PAYGATE_DEMO_ID (1),
      PAYGATE_PUBLIC_HOST (host[:port] or https://host[:port] that clients use; required in production),
      PAYGATE_SELLER (refuse to start, and stop selling, unless resources belong to this address),
      PORT (8402), PAYGATE_HOST (bind, 0.0.0.0), PAYGATE_LOG_JSON (0), PAYGATE_CORS_ORIGINS
      (https://argenestel.github.io), PAYGATE_TRUSTED_PROXIES (IPs whose X-Forwarded-For is
      believed), PAYGATE_RATE (2 req/s per IP), PAYGATE_BURST (30), PAYGATE_MAX_CONNS (64),
      PAYGATE_MAX_CONNS_PER_IP (8), PAYGATE_BLOCK_TAG (latest), PAYGATE_DATA_TTL (30 s)
"""
from __future__ import annotations

import argparse
import base64
import binascii
import http.client
import ipaddress
import json
import math
import os
import re
import socket
import sys
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, replace
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Callable, NamedTuple
from urllib.parse import urlsplit, urlunsplit

from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3

SCHEME = "paygate-native-v2"
X402_SCHEME = "exact-native"          # x402-shaped, NOT a registered x402 scheme
X402_VERSION = 1
NATIVE_ASSET = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"  # conventional "native token" sentinel
WELL_KNOWN = "/.well-known/paygate.json"
NONCE_PERIOD = 300
WEI_PER_USDC = 10**18
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
AUTH_ADDRESS_HEADER = "X-PayGate-Address"
AUTH_SIGNATURE_HEADER = "X-PayGate-Signature"
PAYMENT_HEADER = "X-PAYMENT"
PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE"
MESSAGE_FORMAT = "paygate:2:<chain_id>:<contract_lowercase>:<resource_id>:<nonce>:<host_lowercase>"
NONCE_FORMAT = "floor(unix_seconds / 300)"
HOST_FORMAT = "lowercase host of the URL the client requested, plus :port if not the scheme default"
PAY_SIGNATURE = "pay(uint256,uint32)"
DEFAULT_CORS_ORIGINS = ("https://argenestel.github.io",)
MAX_PAYMENT_HEADER = 2048

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "abi.json")) as f:
    ABI = json.load(f)

_ADDRESS_RE = re.compile(r"0x[0-9a-fA-F]{40}")
_SIGNATURE_RE = re.compile(r"(0x)?[0-9a-fA-F]{130}")
_HOSTNAME_RE = re.compile(r"[a-z0-9]([a-z0-9.\-_]*[a-z0-9])?|\[[0-9a-f:.]+\]")


# ----------------------------------------------------------------------------- helpers

def usdc(wei: int) -> str:
    """Exact decimal string for an 18-decimal amount (no float rounding, no exponent notation)."""
    whole, frac = divmod(int(wei), WEI_PER_USDC)
    return f"{whole}.{frac:018d}".rstrip("0") if frac else str(whole)


def nonce_now() -> int:
    return int(time.time() // NONCE_PERIOD)


def auth_message(chain_id: int, contract: str, rid: int, nonce: int, host: str) -> str:
    """The only text a PayGate buyer ever signs (EIP-191). Must match client.auth_message."""
    return f"paygate:2:{chain_id}:{contract.lower()}:{rid}:{nonce}:{host.lower()}"


def normalize_host(value: str, scheme: str = "https") -> str | None:
    """`host[:port]` as it appears in the signed message: lowercase, IDNA (punycode), IPv6 in
    brackets, port only when it is not the scheme default. Accepts "host", "host:port" or a URL.
    Returns None for anything else. Must agree with client.url_host."""
    value = (value or "").strip()
    try:
        if "://" in value:
            p = urlsplit(value)
            scheme = p.scheme.lower()
        else:
            p = urlsplit("//" + value)
        if p.username or p.password or ("://" not in value and (p.path or p.query or p.fragment)):
            return None
        host, port = p.hostname, p.port
    except ValueError:
        return None
    if not host or scheme not in ("http", "https"):
        return None
    try:
        host = host.encode("idna").decode("ascii").lower() if not host.isascii() else host.lower()
    except UnicodeError:
        return None
    if ":" in host:
        host = f"[{host}]"
    if not _HOSTNAME_RE.fullmatch(host):
        return None
    return f"{host}:{port}" if port is not None and port != (443 if scheme == "https" else 80) else host


def parse_payment_header(value: str, chain_id: int) -> tuple[str, str, int]:
    """Decode an X-PAYMENT header (base64 JSON, x402-shaped) into (from, signature, nonce).
    Raises ValueError with a message that is safe to return to the client."""
    if len(value) > MAX_PAYMENT_HEADER:
        raise ValueError("X-PAYMENT header too large")
    try:
        obj = json.loads(base64.b64decode(value.strip(), validate=True))
    except (binascii.Error, ValueError):
        raise ValueError("X-PAYMENT must be base64-encoded JSON") from None
    version = obj.get("x402Version") if isinstance(obj, dict) else None
    if isinstance(version, bool) or version != X402_VERSION:
        raise ValueError("unsupported x402Version in X-PAYMENT")
    if obj.get("scheme") != X402_SCHEME:
        raise ValueError(f"unsupported X-PAYMENT scheme (this server accepts {X402_SCHEME!r})")
    if obj.get("network") != f"eip155:{chain_id}":
        raise ValueError(f"X-PAYMENT network must be eip155:{chain_id}")
    pl = obj.get("payload")
    if not isinstance(pl, dict):
        raise ValueError("X-PAYMENT payload missing")
    frm, sig, nonce = pl.get("from"), pl.get("signature"), pl.get("nonce")
    if not isinstance(frm, str) or not _ADDRESS_RE.fullmatch(frm):
        raise ValueError("malformed X-PAYMENT payload.from")
    if not isinstance(sig, str) or not _SIGNATURE_RE.fullmatch(sig):
        raise ValueError("malformed X-PAYMENT payload.signature")
    if isinstance(nonce, bool) or not isinstance(nonce, int):
        raise ValueError("malformed X-PAYMENT payload.nonce")
    return frm, sig, nonce


def payment_response(chain_id: int, payer: str, until: int) -> str:
    body = {"success": True, "network": f"eip155:{chain_id}", "payer": payer, "accessUntil": until}
    return base64.b64encode(json.dumps(body, separators=(",", ":")).encode()).decode()


def redact_url(url: str) -> str:
    """Keep scheme://host[:port]; drop userinfo, path and query (RPC API keys live there)."""
    try:
        p = urlsplit(url)
        host = p.hostname or ""
        if p.port:
            host = f"{host}:{p.port}"
        tail = "/..." if (p.path not in ("", "/") or p.query or p.username) else ""
        return urlunsplit((p.scheme, host, "", "", "")) + tail
    except ValueError:
        return "<rpc>"


def _env_flag(env, name: str) -> bool:
    return env.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def _env_list(env, name: str, default: tuple[str, ...] = ()) -> tuple[str, ...]:
    raw = env.get(name)
    if raw is None:
        return default
    return tuple(x.strip().rstrip("/") for x in raw.split(",") if x.strip())


@dataclass
class Config:
    addr: str
    rpc: str = "https://rpc.mainnet.arc.io"
    chain_id: int = 5042
    host: str = "0.0.0.0"
    port: int = 8402
    public_host: str | None = None        # host[:port] clients use; bound into every signature
    public_scheme: str = "https"
    seller: str | None = None             # pin: only sell resources owned by this address
    block_tag: str = "latest"             # "finalized"/"safe" on chains that can reorg
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS
    trusted_proxies: frozenset = frozenset()
    rate: float = 2.0                     # sustained requests/second per client IP (<=0 disables)
    burst: int = 30                       # token bucket size per client IP
    max_conns: int = 64                   # concurrent connections = handler threads
    max_conns_per_ip: int = 8             # per peer IP (trusted proxies are exempt)
    io_timeout: float = 10.0              # per socket read/write
    head_timeout: float = 10.0            # whole request line + headers (slowloris bound)
    max_line: int = 4096                  # request line bytes (414 above)
    max_head: int = 16384                 # request line + headers bytes (431 above)
    quote_ttl: float = 5.0                # cache of on-chain quotes for unauthenticated probes
    data_ttl: float = 30.0                # cache of provider output (0 = call per request)
    rpc_timeout: float = 15.0
    json_logs: bool = False

    def __post_init__(self):
        if not isinstance(self.addr, str) or not Web3.is_address(self.addr):
            raise ValueError(f"PAYGATE_ADDR {self.addr!r} is not an address")
        self.addr = Web3.to_checksum_address(self.addr)
        if self.seller:
            if not Web3.is_address(self.seller):
                raise ValueError(f"PAYGATE_SELLER {self.seller!r} is not an address")
            self.seller = Web3.to_checksum_address(self.seller)
        if self.public_host:
            raw = self.public_host.strip()
            if "://" in raw:
                self.public_scheme = urlsplit(raw).scheme.lower()
            host = normalize_host(raw, self.public_scheme)
            if not host:
                raise ValueError(f"PAYGATE_PUBLIC_HOST {raw!r} is not a host[:port] or http(s) URL")
            self.public_host = host
        self.cors_origins = tuple(o.rstrip("/") for o in self.cors_origins if o and o != "null")
        self.trusted_proxies = frozenset(str(ipaddress.ip_address(p)) for p in self.trusted_proxies)
        if self.max_head <= self.max_line:
            raise ValueError("max_head must exceed max_line")
        if self.max_conns < 1 or self.max_conns_per_ip < 1:
            raise ValueError("connection limits must be >= 1")

    @classmethod
    def from_env(cls, env=None) -> "Config":
        env = os.environ if env is None else env
        if not env.get("PAYGATE_ADDR"):
            raise ValueError("PAYGATE_ADDR (deployed PayGate address) is required")
        return cls(
            addr=env["PAYGATE_ADDR"],
            rpc=env.get("PAYGATE_RPC", cls.rpc),
            chain_id=int(env.get("PAYGATE_CHAIN_ID", cls.chain_id)),
            host=env.get("PAYGATE_HOST", cls.host),
            port=int(env.get("PORT", cls.port)),
            seller=env.get("PAYGATE_SELLER") or None,
            block_tag=env.get("PAYGATE_BLOCK_TAG", cls.block_tag),
            cors_origins=_env_list(env, "PAYGATE_CORS_ORIGINS", DEFAULT_CORS_ORIGINS),
            trusted_proxies=frozenset(_env_list(env, "PAYGATE_TRUSTED_PROXIES")),
            public_host=env.get("PAYGATE_PUBLIC_HOST") or None,
            rate=float(env.get("PAYGATE_RATE", cls.rate)),
            burst=int(env.get("PAYGATE_BURST", cls.burst)),
            max_conns=int(env.get("PAYGATE_MAX_CONNS", cls.max_conns)),
            max_conns_per_ip=int(env.get("PAYGATE_MAX_CONNS_PER_IP", cls.max_conns_per_ip)),
            data_ttl=float(env.get("PAYGATE_DATA_TTL", cls.data_ttl)),
            json_logs=_env_flag(env, "PAYGATE_LOG_JSON"),
        )


class Logger:
    """One line per event: JSON objects with --json, otherwise `ts LEVEL event key=value`."""

    _ctrl = str.maketrans({c: f"\\x{c:02x}" for c in [*range(0x20), *range(0x7F, 0xA0)]})

    def __init__(self, json_mode: bool = False, stream=None, scrub: tuple[str, ...] = ()):
        self.json = json_mode
        self.stream = stream if stream is not None else sys.stderr
        self.scrub = tuple(s for s in scrub if s)
        self._lock = threading.Lock()

    def _clean(self, v):
        if isinstance(v, str):
            for s in self.scrub:
                v = v.replace(s, redact_url(s))
        return v

    def emit(self, level: str, event: str, **fields) -> None:
        fields = {k: self._clean(v) for k, v in fields.items() if v is not None}
        if self.json:
            t = time.time()
            rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int(t % 1 * 1000):03d}Z",
                   "level": level, "event": event, **fields}
            line = json.dumps(rec, separators=(",", ":"), default=str)
        else:
            kv = " ".join(f"{k}={v}" for k, v in fields.items())
            line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {level.upper():5} {event} {kv}".rstrip()
            line = line.translate(self._ctrl)
        with self._lock:
            try:
                self.stream.write(line + "\n")
                self.stream.flush()
            except (OSError, ValueError):
                pass


class RateLimiter:
    """Per-key token bucket. Memory is bounded: when the table is full, refilled buckets are
    dropped first, then the least recently used ones."""

    def __init__(self, rate: float, burst: int, max_keys: int = 10_000):
        self.rate, self.burst, self.max_keys = float(rate), max(1, int(burst)), max_keys
        self._b: OrderedDict[str, tuple[float, float]] = OrderedDict()
        self._lock = threading.Lock()

    def take(self, key: str) -> float:
        """0.0 if a token was taken, else seconds until one is available."""
        if self.rate <= 0:
            return 0.0
        with self._lock:
            now = time.monotonic()
            tokens, last = self._b.pop(key, (float(self.burst), now))
            tokens = min(float(self.burst), tokens + (now - last) * self.rate)
            if tokens >= 1.0:
                self._b[key] = (tokens - 1.0, now)
                wait = 0.0
            else:
                self._b[key] = (tokens, now)
                wait = (1.0 - tokens) / self.rate
            if len(self._b) > self.max_keys:
                self._prune(now)
            return wait

    def _prune(self, now: float) -> None:
        for k, (tok, last) in list(self._b.items()):
            if tok + (now - last) * self.rate >= self.burst:
                del self._b[k]
        while len(self._b) > self.max_keys:
            self._b.popitem(last=False)


class TTLCache:
    """Tiny TTL cache with per-key single flight: N concurrent misses cost one upstream call.
    Keys come from the server's fixed resource map, so the table cannot grow unboundedly.
    Failures are not cached."""

    def __init__(self):
        self._items: dict = {}
        self._locks: dict = {}
        self._lock = threading.Lock()

    def get(self, key, ttl: float, load: Callable):
        if ttl <= 0:
            return load()
        hit = self._items.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        with self._lock:
            key_lock = self._locks.setdefault(key, threading.Lock())
        with key_lock:
            hit = self._items.get(key)
            if hit and hit[0] > time.monotonic():
                return hit[1]
            value = load()
            self._items[key] = (time.monotonic() + ttl, value)
            return value

    def clear(self) -> None:
        self._items.clear()


class Quote(NamedTuple):
    rid: int
    price: int
    window: int
    seller: str
    active: bool
    uri: str

    @property
    def exists(self) -> bool:
        return int(self.seller, 16) != 0


class StartupError(RuntimeError):
    pass


# ----------------------------------------------------------------------------- demo provider

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


# ----------------------------------------------------------------------------- application

class PayGateApp:
    """Chain-facing state shared by all request handlers."""

    def __init__(self, cfg: Config, resources: dict[str, int] | None = None,
                 providers: dict[str, Callable] | None = None, log: Logger | None = None):
        self.cfg = cfg
        self.addr = cfg.addr
        self.chain_id = cfg.chain_id
        self.w3 = Web3(Web3.HTTPProvider(cfg.rpc, request_kwargs={"timeout": cfg.rpc_timeout}))
        self.gate = self.w3.eth.contract(address=self.addr, abi=ABI)
        self.resources = dict(resources) if resources is not None else {"polymarket-rewards": 1}
        self.providers = dict(providers) if providers is not None else dict(PROVIDERS)
        self.log = log or Logger(cfg.json_logs, scrub=(cfg.rpc,))
        self.limiter = RateLimiter(cfg.rate, cfg.burst)
        self._quotes = TTLCache()
        self._data = TTLCache()

    # -- chain reads
    def quote(self, rid: int) -> Quote:
        def load():
            price, window, seller, active, uri = self.gate.functions.quote(rid).call(
                block_identifier=self.cfg.block_tag)
            return Quote(rid, int(price), int(window), Web3.to_checksum_address(seller), bool(active), uri)
        return self._quotes.get(rid, self.cfg.quote_ttl, load)

    def access(self, who: str, rid: int) -> tuple[int, int]:
        """(seconds of access left, accessUntil). The decision uses v2 `remaining`, which is
        computed against block.timestamp and is exclusive at expiry; accessUntil is only read
        for display and can only grow (pay() extends), so reading it second is race-free."""
        tag = self.cfg.block_tag
        rem = int(self.gate.functions.remaining(who, rid).call(block_identifier=tag))
        if rem <= 0:
            return 0, 0
        until = int(self.gate.functions.accessUntil(who, rid).call(block_identifier=tag))
        return rem, until

    def data(self, name: str):
        return self._data.get(name, self.cfg.data_ttl, self.providers[name])

    # -- auth
    def message(self, rid: int, nonce: int, host: str) -> str:
        return auth_message(self.chain_id, self.addr, rid, nonce, host)

    def signature_matches(self, rid: int, addr: str, sig: str, host: str, nonce: int | None = None) -> bool:
        """True if `sig` recovers to `addr` (checksummed) over the message for `host` and the
        current or previous nonce bucket. With an explicit nonce (X-PAYMENT carries one) only
        that bucket is tried, so verification costs one ecrecover instead of two."""
        now = nonce_now()
        buckets = (now, now - 1) if nonce is None else ((nonce,) if nonce in (now, now - 1) else ())
        for n in buckets:
            try:
                signer = Account.recover_message(encode_defunct(text=self.message(rid, n, host)), signature=sig)
            except Exception:  # noqa: BLE001 - malformed signature
                return False
            if signer == addr:
                return True
        return False

    # -- documents
    def not_for_sale(self, q: Quote) -> str | None:
        if not q.active:
            return "resource is not for sale right now"
        if self.cfg.seller and q.seller != self.cfg.seller:
            return "resource is not for sale right now (owner changed)"
        return None

    def auth_block(self, rid: int, host: str, nonce: int | None = None) -> dict:
        """What a buyer needs to prove access: identity of the gate plus the exact message."""
        nonce = nonce_now() if nonce is None else nonce
        return {
            "scheme": SCHEME,
            "chain_id": self.chain_id,
            "contract": self.addr,
            "resource_id": rid,
            "auth": {
                "header_address": AUTH_ADDRESS_HEADER,
                "header_signature": AUTH_SIGNATURE_HEADER,
                "header_payment": PAYMENT_HEADER,
                "message_format": MESSAGE_FORMAT,
                "nonce_format": NONCE_FORMAT,
                "host_format": HOST_FORMAT,
                "nonce": nonce,
                "host": host,
                "message": self.message(rid, nonce, host),
            },
        }

    def payment_required(self, q: Quote, name: str, host: str, scheme: str, reason: str) -> dict:
        """402 body: x402-shaped envelope plus the PayGate fields the reference client verifies.
        No calldata is included on purpose: buyers build pay(id, minWindow) themselves."""
        nonce = nonce_now()
        path = f"/api/{name}"
        return {
            "x402Version": X402_VERSION,
            "error": "PAYMENT_REQUIRED",
            "reason": reason,
            "accepts": [{
                "scheme": X402_SCHEME,
                "network": f"eip155:{self.chain_id}",
                "maxAmountRequired": str(q.price),
                "asset": NATIVE_ASSET,
                "payTo": self.addr,
                "resource": f"{scheme}://{host}{path}",
                "description": f"{name}: {q.window}s of access per payment, paid in native USDC "
                               f"by calling {PAY_SIGNATURE} on the PayGate contract",
                "mimeType": "application/json",
                "maxTimeoutSeconds": 120,
                "extra": {
                    "name": "USDC",
                    "decimals": 18,
                    "paygate": {
                        "contract": self.addr,
                        "resource_id": q.rid,
                        "window_seconds": q.window,
                        "pay": PAY_SIGNATURE,
                        "message_format": MESSAGE_FORMAT,
                    },
                },
            }],
            **self.auth_block(q.rid, host, nonce),
            "price_wei": str(q.price),
            "price_usdc": usdc(q.price),
            "window_seconds": q.window,
            "discovery": WELL_KNOWN,
        }

    def summary(self) -> dict:
        return {"ok": True, "paygate": self.addr, "chain_id": self.chain_id,
                "resources": list(self.resources), "discovery": WELL_KNOWN}

    def discovery(self, host: str | None = None, scheme: str = "https") -> dict:
        items = []
        for name, rid in self.resources.items():
            q = self.quote(rid)
            if not q.exists:
                continue
            path = f"/api/{name}"
            item = {
                "name": name,
                "path": path,
                "resource_id": rid,
                "price_wei": str(q.price),
                "price_usdc": usdc(q.price),
                "window_seconds": q.window,
                "active": q.active,
                "for_sale": self.not_for_sale(q) is None,
                "seller": q.seller,
                "uri": q.uri,
            }
            if host:
                item["url"] = f"{scheme}://{host}{path}"
            items.append(item)
        return {
            "scheme": SCHEME,
            "version": 2,
            "chain_id": self.chain_id,
            "network": f"eip155:{self.chain_id}",
            "contract": self.addr,
            "host": host,
            "auth": {
                "header_address": AUTH_ADDRESS_HEADER,
                "header_signature": AUTH_SIGNATURE_HEADER,
                "header_payment": PAYMENT_HEADER,
                "message_format": MESSAGE_FORMAT,
                "nonce_format": NONCE_FORMAT,
                "host_format": HOST_FORMAT,
                "nonce_period_seconds": NONCE_PERIOD,
                "accepted_buckets": "current and previous",
            },
            "x402": {"x402Version": X402_VERSION, "scheme": X402_SCHEME, "asset": NATIVE_ASSET,
                     "registered_scheme": False},
            "resources": items,
        }

    # -- startup
    def preflight(self) -> list[Quote]:
        """Fail fast on a misconfigured deployment. Raises StartupError."""
        chain = self.w3.eth.chain_id
        if chain != self.chain_id:
            raise StartupError(f"RPC {redact_url(self.cfg.rpc)} is chain {chain}, "
                               f"expected PAYGATE_CHAIN_ID={self.chain_id}")
        if len(self.w3.eth.get_code(self.addr)) == 0:
            raise StartupError(f"no contract code at PAYGATE_ADDR={self.addr} on chain {chain}")
        try:
            self.gate.functions.remaining(ZERO_ADDRESS, 0).call()
            self.gate.functions.MAX_PAGE().call()
        except Exception as e:  # noqa: BLE001
            raise StartupError(f"{self.addr} does not look like PayGate v2 (remaining/MAX_PAGE failed: "
                               f"{type(e).__name__})") from None
        out = []
        for name, rid in self.resources.items():
            q = self.quote(rid)
            if not q.exists:
                raise StartupError(f"resource {rid} ({name}) does not exist on {self.addr}")
            if self.cfg.seller and q.seller != self.cfg.seller:
                raise StartupError(f"resource {rid} is owned by {q.seller}, not PAYGATE_SELLER={self.cfg.seller}")
            if name not in self.providers:
                raise StartupError(f"no data provider for resource {name!r}")
            out.append(q)
        return out


# ----------------------------------------------------------------------------- HTTP layer

class _HeadReader:
    """Wraps the connection's buffered reader while the request line and headers are read.

    http.server applies `timeout` per recv(), so a client trickling one byte every few seconds
    could hold a thread forever (slowloris). This enforces a single deadline for the whole head
    and a total byte budget. Reading goes through peek(), so each blocking recv is bounded by
    the time left. The handler never reads a request body.
    """

    def __init__(self, f, sock, deadline: float, budget: int):
        self._f, self._sock, self._deadline, self._budget = f, sock, deadline, budget

    def readline(self, limit: int = -1) -> bytes:
        if limit is None or limit < 0 or limit > self._budget + 1:
            limit = self._budget + 1
        out = bytearray()
        while len(out) < limit:
            left = self._deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("request head deadline exceeded")
            self._sock.settimeout(left)
            chunk = self._f.peek(1)
            if not chunk:
                break
            nl = chunk.find(b"\n", 0, limit - len(out))
            take = nl + 1 if nl >= 0 else min(len(chunk), limit - len(out))
            out += self._f.read(take)
            if nl >= 0:
                break
        self._budget -= len(out)
        if self._budget < 0:
            raise http.client.LineTooLong("request head exceeds the size limit")
        return bytes(out)

    def close(self):
        self._f.close()

    def __getattr__(self, name):
        return getattr(self._f, name)


class Handler(BaseHTTPRequestHandler):
    """One request per connection (HTTP/1.0 semantics, no keep-alive, no request bodies)."""

    server_version = "PayGate"
    sys_version = ""
    protocol_version = "HTTP/1.0"
    default_request_version = "HTTP/1.0"
    app: PayGateApp  # bound by make_server()

    # -- connection lifecycle
    def setup(self):
        cfg = self.app.cfg
        self.timeout = cfg.io_timeout
        super().setup()
        self._t0 = time.monotonic()
        self.rfile = _HeadReader(self.rfile, self.connection, self._t0 + cfg.head_timeout, cfg.max_head)
        self.requestline, self.command, self.path = "", None, ""
        self._ip, self._origin, self._addr, self._rid = self.client_address[0], None, None, None
        self._linger = False

    def handle(self):
        self.close_connection = True
        self.handle_one_request()

    def finish(self):
        try:
            super().finish()
        finally:
            if self._linger:
                self._lingering_close()

    def _lingering_close(self, max_bytes: int = 256 * 1024, max_seconds: float = 1.0):
        """After rejecting a request we did not read in full (413/414/431/400), half-close and
        discard a bounded amount of input, so the client receives our error instead of a TCP
        reset caused by closing a socket with unread data."""
        try:
            self.connection.shutdown(socket.SHUT_WR)
            deadline, n = time.monotonic() + max_seconds, 0
            while n < max_bytes:
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                self.connection.settimeout(left)
                b = self.connection.recv(65536)
                if not b:
                    break
                n += len(b)
        except OSError:
            pass

    def handle_one_request(self):
        cfg = self.app.cfg
        try:
            try:
                self.raw_requestline = self.rfile.readline(cfg.max_line + 1)
            except http.client.HTTPException:
                return self.send_error(431, "request head too large")
            if len(self.raw_requestline) > cfg.max_line:
                self.request_version = "HTTP/1.0"
                return self.send_error(414, "request line too long")
            if not self.raw_requestline:
                return
            if not self.parse_request():
                return
            self.connection.settimeout(cfg.io_timeout)
            self._dispatch()
            self.wfile.flush()
        except TimeoutError:
            self.close_connection = True
            try:
                self.connection.settimeout(1.0)
                self.request_version = "HTTP/1.0"
                self.send_error(408, "request timeout")
            except OSError:
                pass

    # -- dispatch
    def _dispatch(self):
        self._origin = self.headers.get("Origin")
        self._ip = self._client_ip()
        wait = self.app.limiter.take(self._ip)
        if wait:
            secs = max(1, math.ceil(wait))
            return self._json(429, {"error": "rate limited", "retry_after": secs}, extra={"Retry-After": str(secs)})
        cl = self.headers.get("Content-Length")
        if self.headers.get("Transfer-Encoding") or (cl is not None and cl.strip() != "0"):
            self._linger = True
            return self._json(413, {"error": "request bodies are not accepted"})
        if self.command == "OPTIONS":
            return self._preflight()
        if self.command != "GET":
            return self._json(405, {"error": "method not allowed"}, extra={"Allow": "GET, OPTIONS"})
        try:
            self._get()
        except Exception as e:  # noqa: BLE001 - never drop the connection without a JSON body
            self.app.log.emit("error", "handler_error", error=repr(e)[:500], path=self._log_path(), ip=self._ip)
            self._json(502, {"error": "upstream error"})

    def _get(self):
        app = self.app
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path in ("/", "/health"):
            return self._json(200, app.summary())
        if path == WELL_KNOWN:
            host, scheme = self._public_origin()
            return self._json(200, app.discovery(host, scheme), cache="public, max-age=30")
        if not path.startswith("/api/"):
            return self._json(404, {"error": "not found"})
        name = path[len("/api/"):]
        rid = app.resources.get(name)
        if rid is None:
            return self._json(404, {"error": "unknown resource"})
        self._rid = rid

        host, scheme = self._public_origin()
        if host is None:
            # Never sign for (or accept signatures bound to) a Host we have not verified: that
            # would let a phishing host's signatures replay here.
            return self._json(421, {"error": "misdirected request: unknown Host (operator: set PAYGATE_PUBLIC_HOST)"})

        # Cheap syntactic checks first so garbage credentials never cost an RPC call.
        try:
            addr, sig, nonce = self._credentials()
        except ValueError as e:
            return self._json(400, {"error": str(e)})

        q = app.quote(rid)
        if not q.exists:
            return self._json(404, {"error": "resource does not exist on-chain"})

        if addr:
            if not app.signature_matches(rid, addr, sig, host, nonce):
                return self._json(401, {"error": "bad signature",
                                        "expected_message": app.message(rid, nonce_now(), host)})
            self._addr = addr
            # Paid access is honoured even while the resource is paused (the contract's hasAccess
            # ignores `active`); only new sales stop.
            rem, until = app.access(addr, rid)
            if rem > 0:
                return self._json(200, {"resource": name, "resource_id": rid, "access_until": until,
                                        "access_remaining": rem, "data": app.data(name)},
                                  extra={PAYMENT_RESPONSE_HEADER: payment_response(app.chain_id, addr, until)})

        reason = app.not_for_sale(q)
        if reason:
            # Do not hand out payment instructions the contract would reject (or that would pay
            # someone other than the pinned seller), but do tell existing holders what to sign.
            return self._json(503, {"error": reason, **app.auth_block(q.rid, host)})
        reason = "no active access for this address" if addr else "payment required"
        return self._json(402, app.payment_required(q, name, host, scheme, reason))

    def _credentials(self) -> tuple[str, str, int | None]:
        """(checksummed address, signature, nonce or None) from X-PayGate-* or X-PAYMENT, or
        ("", "", None) when the request is unauthenticated. Raises ValueError (-> 400)."""
        get_all = lambda h: [v.strip() for v in (self.headers.get_all(h) or [])]  # noqa: E731
        addrs, sigs, pays = get_all(AUTH_ADDRESS_HEADER), get_all(AUTH_SIGNATURE_HEADER), get_all(PAYMENT_HEADER)
        if len(addrs) > 1 or len(sigs) > 1 or len(pays) > 1:
            raise ValueError("duplicate authentication header")
        addr, sig, nonce = (addrs or [""])[0], (sigs or [""])[0], None
        pay = (pays or [""])[0]
        if pay:
            if addr or sig:
                raise ValueError("send either X-PAYMENT or X-PayGate-Address/X-PayGate-Signature, not both")
            addr, sig, nonce = parse_payment_header(pay, self.app.chain_id)
        elif addr or sig:
            if not (addr and sig):
                raise ValueError("both X-PayGate-Address and X-PayGate-Signature are required")
            if not _ADDRESS_RE.fullmatch(addr):
                raise ValueError("malformed X-PayGate-Address")
            if not _SIGNATURE_RE.fullmatch(sig):
                raise ValueError("malformed X-PayGate-Signature")
        if addr:
            addr = Web3.to_checksum_address(addr.lower())
        return addr, sig, nonce

    def _public_origin(self) -> tuple[str | None, str]:
        """(host bound into signatures, URL scheme). The configured PAYGATE_PUBLIC_HOST wins and
        the Host header is ignored (proxies rewrite it). Without it, only loopback Host values for
        this server's port are believed (local development); anything else yields None."""
        cfg = self.app.cfg
        if cfg.public_host:
            return cfg.public_host, cfg.public_scheme
        hosts = self.headers.get_all("Host") or []
        if len(hosts) != 1:
            return None, "http"
        h = normalize_host(hosts[0], "http")
        bind, port = self.server.server_address[:2]
        names = {"localhost", "127.0.0.1", "[::1]"}
        if bind not in ("", "0.0.0.0", "::") and normalize_host(bind, "http"):
            names.add(normalize_host(bind, "http"))
        allowed = {n if port == 80 else f"{n}:{port}" for n in names}
        return (h if h in allowed else None), "http"

    def _preflight(self):
        if not self._cors_origin():
            return self._json(403, {"error": "origin not allowed"})
        self.send_response(204)
        for k, v in self._cors_headers(preflight=True).items():
            self.send_header(k, v)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -- CORS
    def _cors_origin(self) -> str | None:
        origins = self.app.cfg.cors_origins
        if "*" in origins:
            return "*"
        o = self._origin
        return o if o and o in origins else None

    def _cors_headers(self, preflight: bool = False) -> dict:
        """CORS for a browser app: GET only, the three auth headers, no credentials. The only
        response header exposed beyond the CORS-safelisted ones is X-PAYMENT-RESPONSE (the
        payer's own address and expiry, also present in the JSON body)."""
        allowed = self._cors_origin()
        h = {}
        if allowed:
            h["Access-Control-Allow-Origin"] = allowed
            if preflight:
                h["Access-Control-Allow-Methods"] = "GET"
                h["Access-Control-Allow-Headers"] = f"{AUTH_ADDRESS_HEADER}, {AUTH_SIGNATURE_HEADER}, {PAYMENT_HEADER}"
                h["Access-Control-Max-Age"] = "600"
            else:
                h["Access-Control-Expose-Headers"] = PAYMENT_RESPONSE_HEADER
        if "*" not in self.app.cfg.cors_origins:
            h["Vary"] = ("Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
                         if preflight else "Origin")
        return h

    # -- responses
    def _json(self, code: int, body: dict, cache: str = "no-store", extra: dict | None = None):
        data = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in {**self._cors_headers(), **(extra or {})}.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_error(self, code, message=None, explain=None):
        """JSON (with CORS) instead of http.server's HTML error page."""
        self.close_connection = True
        self._linger = True
        if getattr(self, "headers", None) is not None and self._origin is None:
            self._origin = self.headers.get("Origin")
        short = self.responses.get(code, ("error",))[0]
        self._json(int(code), {"error": message or short})

    def version_string(self):
        return self.server_version

    # -- client identity and logging
    def _client_ip(self) -> str:
        peer = self.client_address[0]
        trusted = self.app.cfg.trusted_proxies
        if peer in trusted:
            hops = [h.strip() for v in (self.headers.get_all("X-Forwarded-For") or []) for h in v.split(",")]
            for h in reversed([h for h in hops if h]):
                try:
                    ip = str(ipaddress.ip_address(h))
                except ValueError:
                    break
                if ip not in trusted:
                    return ip
        return peer

    def _log_path(self) -> str:
        return (self.path or "").split("?", 1)[0][:200]

    def log_request(self, code="-", size="-"):
        ua = self.headers.get("User-Agent") if getattr(self, "headers", None) is not None else None
        self.app.log.emit(
            "info", "request", ip=self._ip, method=self.command or "-", path=self._log_path(),
            status=int(code), ms=round((time.monotonic() - self._t0) * 1000, 1),
            resource_id=self._rid, address=self._addr, origin=self._origin, ua=(ua or None) and ua[:200])

    def log_error(self, format, *args):
        self.app.log.emit("warn", "http_error", msg=(format % args)[:500], ip=self._ip)

    def log_message(self, format, *args):
        self.app.log.emit("info", "http", msg=(format % args)[:500], ip=self._ip)


H = Handler  # backwards-compatible name


class PayGateHTTPServer(HTTPServer):
    """HTTPServer with a bounded number of handler threads and a per-IP connection cap.
    Connections beyond the caps get an immediate 503/429 from the accept loop instead of a
    thread, so a flood cannot exhaust threads, memory or file descriptors."""

    request_queue_size = 128
    daemon_threads = True

    def __init__(self, address, handler, app: PayGateApp):
        self.app = app
        self._lock = threading.Lock()
        self._active = 0
        self._per_ip: dict[str, int] = {}
        super().__init__(address, handler)

    def server_bind(self):
        # HTTPServer.server_bind does a reverse DNS lookup (socket.getfqdn) we do not need.
        import socketserver
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name, self.server_port = host, port

    def _admit(self, ip: str) -> int:
        cfg = self.app.cfg
        with self._lock:
            if self._active >= cfg.max_conns:
                return 503
            n = self._per_ip.get(ip, 0)
            if n >= cfg.max_conns_per_ip and ip not in cfg.trusted_proxies:
                return 429
            self._active += 1
            self._per_ip[ip] = n + 1
            return 0

    def _release(self, ip: str) -> None:
        with self._lock:
            self._active -= 1
            n = self._per_ip.get(ip, 1) - 1
            if n <= 0:
                self._per_ip.pop(ip, None)
            else:
                self._per_ip[ip] = n

    @property
    def active_connections(self) -> int:
        return self._active

    def process_request(self, request, client_address):
        ip = client_address[0]
        code = self._admit(ip)
        if code:
            self._reject(request, code)
            self.app.log.emit("warn", "connection_rejected", ip=ip, status=code)
            self.shutdown_request(request)
            return
        t = threading.Thread(target=self._work, args=(request, client_address, ip), daemon=True)
        try:
            t.start()
        except RuntimeError:
            self._release(ip)
            self.shutdown_request(request)

    def _work(self, request, client_address, ip):
        try:
            self.finish_request(request, client_address)
        except Exception:  # noqa: BLE001
            self.handle_error(request, client_address)
        finally:
            self.shutdown_request(request)
            self._release(ip)

    @staticmethod
    def _reject(request, code: int) -> None:
        reason = "Service Unavailable" if code == 503 else "Too Many Requests"
        body = b'{"error":"too many connections, retry shortly"}'
        head = (f"HTTP/1.0 {code} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n"
                f"Retry-After: 1\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode()
        try:
            request.settimeout(0.5)
            request.sendall(head + body)
        except OSError:
            pass

    def handle_error(self, request, client_address):
        self.app.log.emit("error", "connection_error", ip=client_address[0], error=repr(sys.exc_info()[1])[:500])


def make_server(app: PayGateApp, host: str | None = None, port: int | None = None,
                handler: type[Handler] = Handler) -> PayGateHTTPServer:
    bound = type(f"Bound{handler.__name__}", (handler,), {"app": app})
    host = app.cfg.host if host is None else host
    port = app.cfg.port if port is None else port
    return PayGateHTTPServer((host, port), bound, app)


def main(argv=None):
    p = argparse.ArgumentParser(description="PayGate HTTP 402 server (see module docstring for env vars)")
    p.add_argument("--host", help="bind address (env PAYGATE_HOST, default 0.0.0.0; use 127.0.0.1 behind a proxy)")
    p.add_argument("--port", type=int, help="listen port (env PORT, default 8402)")
    p.add_argument("--json", action="store_true", help="structured JSON logs, one object per line (env PAYGATE_LOG_JSON=1)")
    args = p.parse_args(argv)
    try:
        cfg = Config.from_env()
    except ValueError as e:
        sys.exit(str(e))
    cfg = replace(cfg, host=args.host or cfg.host, port=args.port or cfg.port, json_logs=args.json or cfg.json_logs)
    log = Logger(cfg.json_logs, scrub=(cfg.rpc,))
    app = PayGateApp(cfg, resources={"polymarket-rewards": int(os.environ.get("PAYGATE_DEMO_ID", "1"))}, log=log)
    try:
        for q in app.preflight():
            log.emit("info", "resource", resource_id=q.rid, price_usdc=usdc(q.price), window_seconds=q.window,
                     seller=q.seller, active=q.active)
    except StartupError as e:
        log.emit("error", "startup_failed", error=str(e))
        sys.exit(f"startup check failed: {e}")
    except Exception as e:  # noqa: BLE001 - RPC unreachable etc.
        log.emit("error", "startup_failed", error=repr(e)[:500])
        sys.exit("startup check failed: RPC error (see log)")
    httpd = make_server(app)
    if not cfg.public_host:
        log.emit("warn", "no_public_host", msg="PAYGATE_PUBLIC_HOST is not set: only loopback Host headers are "
                 "served (local development). Set it to the host clients use, e.g. api.example.com")
    log.emit("info", "listening", host=cfg.host, port=httpd.server_address[1], contract=cfg.addr,
             chain_id=cfg.chain_id, public_host=cfg.public_host, rpc=redact_url(cfg.rpc), block_tag=cfg.block_tag)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
