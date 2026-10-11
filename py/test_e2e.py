"""End-to-end tests of the PayGate 402 server and client against a local anvil chain.

    cd py && ../../.venv/bin/python -m unittest -v test_e2e      (needs `anvil` and `forge build`)
    PAYGATE_TEST_ARTIFACT=/path/to/PayGate.json ...             (test a specific build instead of ../out)

Deploys PayGate v2 from the forge artifact, runs server.py in-process (several instances with
different limits) with the demo data provider stubbed, and drives client.py (library and CLI)
through 402 -> pay -> 200, plus the paths a hostile client, a hostile server or a phishing host
would exercise. Never touches a real network: anvil only.
"""
import base64
import importlib
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3

HERE = os.path.dirname(os.path.abspath(__file__))
# Override to pin a specific build (e.g. while src/ is being mutation-tested): PAYGATE_TEST_ARTIFACT=path
ARTIFACT = os.environ.get("PAYGATE_TEST_ARTIFACT") or os.path.join(HERE, "..", "out", "PayGate.sol", "PayGate.json")
# anvil's default funded accounts (test keys only; chain id 31337)
SELLER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
BUYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
CHAIN = 31337
PRICE = 10**16  # 0.01 "USDC"
WINDOW = 3600
SHORT_WINDOW = 120
ORIGIN = "https://argenestel.github.io"
STUB = {"pools": [{"condition_id": "0xabc"}]}
NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"

# Never let the developer's real environment leak into the tests (or the CLI subprocesses).
for _k in [k for k in os.environ if k.startswith("PAYGATE_") or k == "EVM_PRIVATE_KEY"]:
    del os.environ[_k]

sys.path.insert(0, HERE)
server = importlib.import_module("server")
client = importlib.import_module("client")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def b64json(obj) -> str:
    return base64.b64encode(json.dumps(obj).encode()).decode()


def raw_request(port: int, payload: bytes, timeout: float = 5.0) -> bytes:
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
        s.sendall(payload)
        chunks = []
        while True:
            try:
                c = s.recv(65536)
            except (ConnectionResetError, socket.timeout):
                break
            if not c:
                break
            chunks.append(c)
    return b"".join(chunks)


def status_of(resp: bytes) -> int:
    return int(resp.split(b" ", 2)[1])


def body_of(resp: bytes) -> dict:
    return json.loads(resp.split(b"\r\n\r\n", 1)[1])


class E2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rpc_port = free_port()
        cls.anvil = subprocess.Popen(["anvil", "--port", str(cls.rpc_port), "--silent"])
        cls.rpc = f"http://127.0.0.1:{cls.rpc_port}"
        cls.w3 = Web3(Web3.HTTPProvider(cls.rpc))
        for _ in range(100):
            try:
                cls.w3.eth.chain_id
                break
            except Exception:
                time.sleep(0.1)
        with open(ARTIFACT) as fh:
            art = json.load(fh)
        cls.seller = Account.from_key(SELLER_KEY).address
        cls.w3.eth.default_account = cls.seller
        c = cls.w3.eth.contract(abi=art["abi"], bytecode=art["bytecode"]["object"])
        cls.addr = cls.w3.eth.wait_for_transaction_receipt(c.constructor().transact())["contractAddress"]
        cls.gate = cls.w3.eth.contract(address=cls.addr, abi=art["abi"])
        f = cls.gate.functions
        for price, window, uri in ((PRICE, WINDOW, "demo"), (PRICE, WINDOW, "paused"), (PRICE, SHORT_WINDOW, "short"),
                                   (PRICE, WINDOW, "pausable"), (PRICE, WINDOW, "transferable")):
            cls.tx(f.createResource(price, window, uri))
        cls.tx(f.updateResource(2, PRICE, WINDOW, False, "paused"))

        cls.resources = {"polymarket-rewards": 1, "paused": 2, "short": 3, "pausable": 4, "transferable": 5,
                         "ghost": 99}
        cls.provider_calls = 0

        def stub():
            cls.provider_calls += 1
            return STUB
        cls.providers = {name: stub for name in cls.resources}
        cls.lock_dir = tempfile.mkdtemp(prefix="paygate-locks-")
        cls.log = io.StringIO()
        cls.app = cls.make_app(log=server.Logger(False, stream=cls.log))
        cls.httpd, cls.base, cls.port = cls.serve(cls.app)
        cls.host = f"127.0.0.1:{cls.port}"
        cls.buyer = Account.from_key(BUYER_KEY)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.anvil.terminate()
        cls.anvil.wait()

    # ------------------------------------------------------------------ helpers

    @classmethod
    def tx(cls, fn, **kw):
        return cls.w3.eth.wait_for_transaction_receipt(fn.transact(kw or None))

    @classmethod
    def make_app(cls, log=None, resources=None, providers=None, **cfg):
        base = dict(addr=cls.addr, rpc=cls.rpc, chain_id=CHAIN, host="127.0.0.1", port=0, seller=cls.seller,
                    rate=0, quote_ttl=0, data_ttl=0)
        base.update(cfg)
        return server.PayGateApp(server.Config(**base), resources=resources or cls.resources,
                                 providers=providers or cls.providers,
                                 log=log or server.Logger(False, stream=io.StringIO()))

    @classmethod
    def serve(cls, app, handler=None):
        httpd = server.make_server(app, "127.0.0.1", 0, **({"handler": handler} if handler else {}))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        port = httpd.server_address[1]
        return httpd, f"http://127.0.0.1:{port}", port

    def serve_temp(self, app, handler=None):
        httpd, base, port = self.serve(app, handler)

        def stop():
            httpd.shutdown()
            httpd.server_close()
        self.addCleanup(stop)
        return httpd, base, port

    def url(self, name="polymarket-rewards", base=None):
        return f"{base or self.base}/api/{name}"

    def fresh_buyer(self):
        acct = Account.create()
        self.w3.provider.make_request("anvil_setBalance", [acct.address, hex(10**20)])
        return Web3.to_hex(acct.key), acct.address

    def pay_direct(self, key, rid):
        acct = Account.from_key(key)
        tx = self.gate.functions.pay(rid, 0).build_transaction(
            {"from": acct.address, "value": PRICE, "nonce": self.w3.eth.get_transaction_count(acct.address)})
        h = self.w3.eth.send_raw_transaction(acct.sign_transaction(tx).raw_transaction)
        return self.w3.eth.wait_for_transaction_receipt(h)

    def sign(self, key, rid=1, host=None, nonce=None, contract=None, chain=CHAIN):
        return client.auth_headers(key, chain, contract or self.addr, rid,
                                   client.current_nonce() if nonce is None else nonce, host or self.host)

    def nonce_of(self, address):
        return self.w3.eth.get_transaction_count(address)

    def fetch(self, url, key, **kw):
        kw.setdefault("pinned_contract", self.addr)
        kw.setdefault("lock_dir", self.lock_dir)
        kw.setdefault("log", lambda m: None)
        return client.fetch(url, key, self.rpc, chain_id=CHAIN, **kw)

    # ------------------------------------------------------------------ 402 shape and auth

    def test_01_unauthenticated_402_is_x402_shaped_and_host_bound(self):
        r = httpx.get(self.url())
        self.assertEqual(r.status_code, 402)
        ins = r.json()
        nonce = ins["auth"]["nonce"]
        # x402 envelope (native scheme, not EIP-3009)
        self.assertEqual(ins["x402Version"], 1)
        self.assertEqual(ins["error"], "PAYMENT_REQUIRED")
        self.assertEqual(ins["reason"], "payment required")
        self.assertEqual(ins["accepts"], [{
            "scheme": "exact-native",
            "network": "eip155:31337",
            "maxAmountRequired": str(PRICE),
            "asset": NATIVE,
            "payTo": self.addr,
            "resource": f"http://{self.host}/api/polymarket-rewards",
            "description": ins["accepts"][0]["description"],
            "mimeType": "application/json",
            "maxTimeoutSeconds": 120,
            "extra": {"name": "USDC", "decimals": 18, "paygate": {
                "contract": self.addr, "resource_id": 1, "window_seconds": WINDOW, "pay": "pay(uint256,uint32)",
                "message_format": "paygate:2:<chain_id>:<contract_lowercase>:<resource_id>:<nonce>:<host_lowercase>"}},
        }])
        # PayGate fields
        self.assertEqual(ins["scheme"], "paygate-native-v2")
        self.assertEqual(ins["chain_id"], CHAIN)
        self.assertEqual(ins["contract"], self.addr)
        self.assertEqual(ins["price_wei"], str(PRICE))
        self.assertEqual(ins["price_usdc"], "0.01")
        self.assertEqual(ins["window_seconds"], WINDOW)
        self.assertNotIn("pay_calldata", ins)  # buyers build pay(id, minWindow) themselves
        self.assertEqual(ins["auth"]["host"], self.host)
        self.assertEqual(ins["auth"]["message"], f"paygate:2:31337:{self.addr.lower()}:1:{nonce}:{self.host}")
        self.assertEqual(ins["auth"]["header_payment"], "X-PAYMENT")
        self.assertEqual(r.headers["Cache-Control"], "no-store")
        self.assertEqual(r.headers["Server"], "PayGate")  # no Python version disclosure
        self.assertNotIn("access-control-allow-origin", r.headers)
        self.assertEqual(r.headers["Vary"], "Origin")

    def test_02_full_flow_pays_once_then_reuses_access(self):
        before = self.w3.eth.get_balance(self.buyer.address)
        out = self.fetch(self.url(), BUYER_KEY)
        self.assertEqual(out["data"], STUB)
        self.assertTrue(self.gate.functions.hasAccess(self.buyer.address, 1).call())
        self.assertEqual(self.gate.functions.balances(self.seller).call(), PRICE)
        self.assertGreaterEqual(before - self.w3.eth.get_balance(self.buyer.address), PRICE)
        self.assertGreater(out["access_remaining"], WINDOW - 60)
        nonce = self.nonce_of(self.buyer.address)
        # second fetch: signature only, no new transaction
        out2 = self.fetch(self.url(), BUYER_KEY)
        self.assertEqual(out2["access_until"], out["access_until"])
        self.assertEqual(self.nonce_of(self.buyer.address), nonce)

    def test_03_bad_signature_is_401_and_message_is_fully_bound(self):
        n = client.current_nonce()
        other = Account.create()
        hdr = self.sign(other.key)
        hdr["X-PayGate-Address"] = self.buyer.address  # claim buyer's address with another key
        self.assertEqual(httpx.get(self.url(), headers=hdr).status_code, 401)
        # a signature for another chain / contract / resource / stale bucket / host is rejected
        for kw in (dict(chain=1), dict(contract=Account.create().address), dict(rid=2), dict(nonce=n - 2),
                   dict(nonce=n + 1), dict(host="evil.example"), dict(host="127.0.0.1")):
            r = httpx.get(self.url(), headers=self.sign(BUYER_KEY, **kw))
            self.assertEqual(r.status_code, 401, kw)
        self.assertEqual(r.json()["expected_message"], f"paygate:2:31337:{self.addr.lower()}:1:{n}:{self.host}")
        # the v1 (host-less) message format is no longer accepted
        v1 = f"paygate:{CHAIN}:{self.addr.lower()}:1:{n}"
        sig = Account.sign_message(encode_defunct(text=v1), private_key=BUYER_KEY).signature
        hdr = {"X-PayGate-Address": self.buyer.address, "X-PayGate-Signature": Web3.to_hex(sig)}
        self.assertEqual(httpx.get(self.url(), headers=hdr).status_code, 401)
        # previous bucket is still accepted (5-minute boundary tolerance)
        r = httpx.get(self.url(), headers=self.sign(BUYER_KEY, nonce=n - 1))
        self.assertEqual(r.status_code, 200)
        # PayGate headers also get the x402 settlement header
        resp = client.decode_payment_response(r.headers["X-PAYMENT-RESPONSE"])
        self.assertEqual(resp, {"success": True, "network": "eip155:31337", "payer": self.buyer.address,
                                "accessUntil": r.json()["access_until"]})

    def test_04_phishing_host_cannot_replay_signatures(self):
        # (a) a signature bound to another host is useless here, even if the Host header lies
        evil_sig = self.sign(BUYER_KEY, host="evil.example")
        self.assertEqual(httpx.get(self.url(), headers=evil_sig).status_code, 401)
        for hdr in ({"Host": "evil.example"}, {"Host": "evil.example", **evil_sig}):
            r = httpx.get(self.url(), headers=hdr)
            self.assertEqual(r.status_code, 421)  # unknown Host: never sign for it, never verify for it

        # (b) a relay that serves the genuine 402: the client refuses, no signature leaves
        seen = []
        real = self.url()

        class Relay(BaseHTTPRequestHandler):
            mode = "verbatim"

            def do_GET(self):
                seen.append({k.lower(): v for k, v in self.headers.items()})
                body = httpx.get(real).json()
                if Relay.mode == "rewrite":  # re-bind the message to the relay's own host
                    a = body["auth"]
                    a["host"] = self.headers["Host"]
                    a["message"] = client.auth_message(CHAIN, body["contract"], 1, a["nonce"], a["host"])
                data = json.dumps(body).encode()
                self.send_response(402)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass
        relay = ThreadingHTTPServer(("127.0.0.1", 0), Relay)
        threading.Thread(target=relay.serve_forever, daemon=True).start()
        self.addCleanup(relay.server_close)
        self.addCleanup(relay.shutdown)
        relay_url = f"http://localhost:{relay.server_address[1]}/api/polymarket-rewards"
        nonce = self.nonce_of(self.buyer.address)
        with self.assertRaisesRegex(client.PayGateError, "unexpected message"):
            self.fetch(relay_url, BUYER_KEY)
        self.assertFalse(any("x-paygate-signature" in h for h in seen))

        # (c) a relay that re-binds the message to itself gets a signature for itself only
        Relay.mode = "rewrite"
        with self.assertRaises(client.PayGateError):
            self.fetch(relay_url, BUYER_KEY, retries=1, backoff=0)
        stolen = [h for h in seen if "x-paygate-signature" in h][-1]
        replay = {"X-PayGate-Address": stolen["x-paygate-address"], "X-PayGate-Signature": stolen["x-paygate-signature"]}
        self.assertEqual(httpx.get(self.url(), headers=replay).status_code, 401)
        self.assertEqual(self.nonce_of(self.buyer.address), nonce)  # buyer held access: no payment

        # (d) with PAYGATE_PUBLIC_HOST the configured host is bound and the Host header ignored
        app = self.make_app(public_host="https://API.Example.com:443")
        _, base, port = self.serve_temp(app)
        ins = httpx.get(self.url(base=base), headers={"Host": "evil.example"}).json()
        self.assertEqual(ins["auth"]["host"], "api.example.com")
        self.assertEqual(ins["accepts"][0]["resource"], "https://api.example.com/api/polymarket-rewards")
        self.assertEqual(httpx.get(self.url(base=base), headers=self.sign(BUYER_KEY, host="api.example.com")).status_code, 200)
        self.assertEqual(httpx.get(self.url(base=base), headers=self.sign(BUYER_KEY, host=f"127.0.0.1:{port}")).status_code, 401)
        # a client that reached it by another name refuses to sign
        with self.assertRaisesRegex(client.PayGateError, "unexpected message"):
            self.fetch(self.url(base=base), BUYER_KEY)

    def test_05_malformed_credentials_are_400_without_rpc(self):
        calls = []
        self.app.quote = lambda *a: calls.append("quote")
        self.app.access = lambda *a: calls.append("access")
        try:
            good = self.sign(BUYER_KEY)
            n = client.current_nonce()
            bad = [
                {"X-PayGate-Address": "nope", "X-PayGate-Signature": "0x00"},
                {"X-PayGate-Address": self.buyer.address},
                {"X-PayGate-Signature": good["X-PayGate-Signature"]},
                {"X-PayGate-Address": self.buyer.address, "X-PayGate-Signature": "0x" + "zz" * 65},
                {**good, "X-PAYMENT": client.x_payment_header(BUYER_KEY, CHAIN, self.addr, 1, n, self.host)["X-PAYMENT"]},
                {"X-PAYMENT": "!!not base64!!"},
                {"X-PAYMENT": base64.b64encode(b"[1,2]").decode()},
                {"X-PAYMENT": "A" * 3000},
            ]
            payload = {"from": self.buyer.address, "signature": good["X-PayGate-Signature"], "nonce": n}
            for env in ({"x402Version": 2, "scheme": "exact-native", "network": "eip155:31337"},
                        {"x402Version": True, "scheme": "exact-native", "network": "eip155:31337"},
                        {"x402Version": 1, "scheme": "exact", "network": "eip155:31337"},
                        {"x402Version": 1, "scheme": "exact-native", "network": "eip155:1"}):
                bad.append({"X-PAYMENT": b64json({**env, "payload": payload})})
            for field, value in (("nonce", True), ("nonce", "1"), ("from", "0x1234"), ("signature", "0x00")):
                bad.append({"X-PAYMENT": b64json({"x402Version": 1, "scheme": "exact-native", "network": "eip155:31337",
                                                  "payload": {**payload, field: value}})})
            for hdr in bad:
                r = httpx.get(self.url(), headers=hdr)
                self.assertEqual(r.status_code, 400, (hdr, r.text))
            # duplicate headers are ambiguous behind proxies: rejected
            dup = [("X-PayGate-Address", self.buyer.address), ("X-PayGate-Address", Account.create().address),
                   ("X-PayGate-Signature", good["X-PayGate-Signature"])]
            self.assertEqual(httpx.get(self.url(), headers=dup).status_code, 400)
            self.assertEqual(calls, [])
        finally:
            del self.app.quote, self.app.access
        # the address header is case-insensitive (the signature is what authenticates)
        hdr = self.sign(BUYER_KEY)
        hdr["X-PayGate-Address"] = hdr["X-PayGate-Address"].lower()
        self.assertEqual(httpx.get(self.url(), headers=hdr).status_code, 200)

    def test_06_x_payment_header_is_an_alternative_proof(self):
        n = client.current_nonce()
        xp = lambda key, nonce=n, host=None: client.x_payment_header(  # noqa: E731
            key, CHAIN, self.addr, 1, nonce, host or self.host)
        r = httpx.get(self.url(), headers=xp(BUYER_KEY))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["data"], STUB)
        until = self.gate.functions.accessUntil(self.buyer.address, 1).call()
        self.assertEqual(client.decode_payment_response(r.headers["X-PAYMENT-RESPONSE"]),
                         {"success": True, "network": "eip155:31337", "payer": self.buyer.address, "accessUntil": until})
        self.assertEqual(httpx.get(self.url(), headers=xp(BUYER_KEY, n - 1)).status_code, 200)
        for hdr in (xp(BUYER_KEY, n - 2), xp(BUYER_KEY, n + 1), xp(BUYER_KEY, host="evil.example")):
            self.assertEqual(httpx.get(self.url(), headers=hdr).status_code, 401)
        # a stranger's valid proof: 402 with requirements, not 200
        key, _ = self.fresh_buyer()
        r = httpx.get(self.url(), headers=xp(key))
        self.assertEqual(r.status_code, 402)
        self.assertEqual(r.json()["reason"], "no active access for this address")

    def test_07_unknown_paused_ghost_resources_and_paths(self):
        self.assertEqual(httpx.get(self.url("nothing")).status_code, 404)
        self.assertEqual(httpx.get(self.url("paused")).status_code, 503)
        self.assertEqual(httpx.get(self.url("ghost")).status_code, 404)
        self.assertEqual(httpx.get(f"{self.base}/admin").status_code, 404)
        self.assertEqual(httpx.get(f"{self.base}//api/nothing").status_code, 404)
        r = httpx.get(f"{self.base}/")
        self.assertEqual(r.json(), {"ok": True, "paygate": self.addr, "chain_id": CHAIN,
                                    "resources": list(self.resources), "discovery": "/.well-known/paygate.json"})

    def test_08_provider_failure_is_502_json_without_details(self):
        def boom():
            raise RuntimeError("upstream down at https://secret.internal/key=abc")
        orig = self.app.providers["polymarket-rewards"]
        self.app.providers["polymarket-rewards"] = boom
        try:
            r = httpx.get(self.url(), headers=self.sign(BUYER_KEY))
            self.assertEqual(r.status_code, 502)
            self.assertEqual(r.json(), {"error": "upstream error"})
            self.assertIn("handler_error", self.log.getvalue())
        finally:
            self.app.providers["polymarket-rewards"] = orig

    # ------------------------------------------------------------------ client vs hostile servers

    def test_09_client_rejects_malicious_402_without_transacting(self):
        good = httpx.get(self.url()).json()
        nonce = self.nonce_of(self.buyer.address)
        attacker = Account.create().address
        a, n = good["auth"], good["auth"]["nonce"]
        msg = lambda contract=self.addr, rid=1, nn=n, host=self.host: client.auth_message(  # noqa: E731
            CHAIN, contract, rid, nn, host)
        cases = {
            "wrong contract": {**good, "contract": attacker},
            "wrong chain": {**good, "chain_id": 1},
            "chain as string": {**good, "chain_id": "31337"},
            "v1 scheme": {**good, "scheme": "paygate-native-v1"},
            "wrong scheme": {**good, "scheme": "send-me-eth"},
            "foreign message": {**good, "auth": {**a, "message": "login to exchange"}},
            "message for other contract": {**good, "auth": {**a, "message": msg(contract=attacker)}},
            "message for other host": {**good, "auth": {**a, "message": msg(host="evil.example")}},
            "v1 message": {**good, "auth": {**a, "message": f"paygate:31337:{self.addr.lower()}:1:{n}"}},
            "future nonce": {**good, "auth": {**a, "nonce": n + 10, "message": msg(nn=n + 10)}},
            "garbage price": {**good, "price_wei": "lots"},
            "negative price": {**good, "price_wei": -1},
            "bool resource id": {**good, "resource_id": True},
            "float window": {**good, "window_seconds": 3600.5},
            "window > uint32": {**good, "window_seconds": 2**32},
            "auth not object": {**good, "auth": "x"},
        }
        for name, ins in cases.items():
            with self.assertRaises(client.PayGateError, msg=name):
                client.validate_instructions(ins, CHAIN, self.addr, host=self.host)
        for body in ([good], "402", None):
            with self.assertRaises(client.PayGateError):
                client.validate_instructions(body, CHAIN, self.addr, host=self.host)
        with self.assertRaises(client.PayGateError):  # pinned contract mismatch
            client.validate_instructions(good, CHAIN, attacker, host=self.host)
        with self.assertRaises(client.PayGateError):  # pinned resource mismatch
            client.validate_instructions(good, CHAIN, self.addr, host=self.host, pinned_rid=2)
        # inflated price / overlong window promise / spend cap / inactive: refused before any tx
        for kw in (dict(price=PRICE * 2, window=WINDOW), dict(price=PRICE, window=WINDOW * 2)):
            with self.assertRaises(client.PayGateError):
                client.pay(self.w3, BUYER_KEY, self.addr, 1, max_wei=10**18, **kw)
        with self.assertRaisesRegex(client.PayGateError, "spend cap"):
            client.pay(self.w3, BUYER_KEY, self.addr, 1, PRICE, WINDOW, max_wei=PRICE - 1)
        with self.assertRaisesRegex(client.PayGateError, "inactive"):
            client.pay(self.w3, BUYER_KEY, self.addr, 2, PRICE, WINDOW, max_wei=10**18)
        self.assertEqual(self.nonce_of(self.buyer.address), nonce)

    def test_10_client_does_not_pay_on_401_or_5xx(self):
        key, who = self.fresh_buyer()
        for code in (401, 500):
            class Flaky(server.Handler):
                def _get(self, code=code):
                    if self.headers.get("X-PayGate-Signature"):
                        return self._json(code, {"error": "boom"})
                    return super()._get()
            _, base, _ = self.serve_temp(self.app, Flaky)
            with self.assertRaisesRegex(client.PayGateError, "not paying"):
                self.fetch(self.url(base=base), key)
        self.assertEqual(self.nonce_of(who), 0)

    def test_11_client_requires_a_pinned_contract(self):
        with self.assertRaisesRegex(client.PayGateError, "no PayGate contract pinned"):
            self.fetch(self.url(), BUYER_KEY, pinned_contract=None)
        # explicit opt-out still works (the buyer already holds access, so nothing is paid)
        nonce = self.nonce_of(self.buyer.address)
        out = self.fetch(self.url(), BUYER_KEY, pinned_contract=None, allow_any_contract=True)
        self.assertEqual(out["data"], STUB)
        self.assertEqual(self.nonce_of(self.buyer.address), nonce)

    # ------------------------------------------------------------------ v2 semantics

    def test_12_exclusive_expiry_boundary(self):
        key, who = self.fresh_buyer()
        self.pay_direct(key, 3)
        until = self.gate.functions.accessUntil(who, 3).call()
        self.w3.provider.make_request("evm_mine", [until - 1])
        r = httpx.get(self.url("short"), headers=self.sign(key, rid=3))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["access_remaining"], 1)
        self.assertEqual(r.json()["access_until"], until)
        self.w3.provider.make_request("evm_mine", [until])
        self.assertFalse(self.gate.functions.hasAccess(who, 3).call())
        r = httpx.get(self.url("short"), headers=self.sign(key, rid=3))
        self.assertEqual(r.status_code, 402)
        self.assertEqual(r.json()["reason"], "no active access for this address")

    def test_13_paused_resource_still_serves_paid_access(self):
        key, who = self.fresh_buyer()
        self.pay_direct(key, 4)
        self.tx(self.gate.functions.updateResource(4, PRICE, WINDOW, False, "pausable"))
        try:
            self.assertEqual(httpx.get(self.url("pausable"), headers=self.sign(key, rid=4)).status_code, 200)
            self.assertEqual(self.fetch(self.url("pausable"), key)["data"], STUB)
            stranger, who2 = self.fresh_buyer()
            self.assertEqual(httpx.get(self.url("pausable"), headers=self.sign(stranger, rid=4)).status_code, 503)
            r = httpx.get(self.url("pausable"))
            self.assertEqual(r.status_code, 503)
            self.assertNotIn("accepts", r.json())  # no payment instructions while paused...
            self.assertEqual(r.json()["auth"]["message"],  # ...but holders still learn what to sign
                             client.auth_message(CHAIN, self.addr, 4, r.json()["auth"]["nonce"], self.host))
            with self.assertRaisesRegex(client.PayGateError, "holds no access"):
                self.fetch(self.url("pausable"), stranger)
            self.assertEqual(self.nonce_of(who2), 0)
        finally:
            self.tx(self.gate.functions.updateResource(4, PRICE, WINDOW, True, "pausable"))

    def test_14_seller_pin_stops_sales_after_transfer(self):
        self.assertEqual(httpx.get(self.url("transferable")).status_code, 402)
        self.tx(self.gate.functions.transferResource(5, Account.create().address))
        r = httpx.get(self.url("transferable"))
        self.assertEqual(r.status_code, 503)
        self.assertIn("owner changed", r.json()["error"])

    def test_15_discovery_document(self):
        r = httpx.get(f"{self.base}/.well-known/paygate.json", headers={"Origin": ORIGIN})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertEqual(r.headers["Cache-Control"], "public, max-age=30")
        self.assertEqual(r.headers["Vary"], "Origin")
        d = r.json()
        self.assertEqual({k: d[k] for k in ("scheme", "version", "chain_id", "network", "contract", "host")},
                         {"scheme": "paygate-native-v2", "version": 2, "chain_id": CHAIN, "network": "eip155:31337",
                          "contract": self.addr, "host": self.host})
        self.assertEqual(d["auth"]["message_format"],
                         "paygate:2:<chain_id>:<contract_lowercase>:<resource_id>:<nonce>:<host_lowercase>")
        self.assertEqual(d["auth"]["nonce_period_seconds"], 300)
        self.assertEqual(d["x402"], {"x402Version": 1, "scheme": "exact-native", "asset": NATIVE,
                                     "registered_scheme": False})
        res = {x["name"]: x for x in d["resources"]}
        self.assertEqual(set(res), set(self.resources) - {"ghost"})  # resources missing on-chain are omitted
        self.assertEqual(res["polymarket-rewards"], {
            "name": "polymarket-rewards", "path": "/api/polymarket-rewards", "resource_id": 1,
            "price_wei": str(PRICE), "price_usdc": "0.01", "window_seconds": WINDOW, "active": True,
            "for_sale": True, "seller": self.seller, "uri": "demo",
            "url": f"http://{self.host}/api/polymarket-rewards"})
        self.assertFalse(res["paused"]["active"])
        self.assertFalse(res["paused"]["for_sale"])
        # an unverified Host never makes it into absolute URLs
        d = httpx.get(f"{self.base}/.well-known/paygate.json", headers={"Host": "evil.example"}).json()
        self.assertIsNone(d["host"])
        self.assertFalse(any("url" in x for x in d["resources"]))
        # the client's discover() rebuilds URLs from the base it was given
        out = client.discover(self.base, log=lambda m: None)
        self.assertIn(self.url(), [x["url"] for x in out["resources"]])

    # ------------------------------------------------------------------ HTTP hardening

    def test_16_cors(self):
        pre = {"Origin": ORIGIN, "Access-Control-Request-Method": "GET",
               "Access-Control-Request-Headers": "x-paygate-address,x-paygate-signature,x-payment"}
        r = httpx.options(self.url(), headers=pre)
        self.assertEqual(r.status_code, 204)
        self.assertEqual(r.headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertEqual(r.headers["Access-Control-Allow-Methods"], "GET")
        self.assertEqual(r.headers["Access-Control-Allow-Headers"], "X-PayGate-Address, X-PayGate-Signature, X-PAYMENT")
        self.assertEqual(r.headers["Access-Control-Max-Age"], "600")
        self.assertEqual(r.headers["Vary"], "Origin, Access-Control-Request-Method, Access-Control-Request-Headers")
        self.assertNotIn("access-control-allow-credentials", r.headers)
        for origin in ("https://evil.example", "null", "https://argenestel.github.io.evil.example", None):
            h = {**pre, "Origin": origin} if origin else {k: v for k, v in pre.items() if k != "Origin"}
            r = httpx.options(self.url(), headers=h)
            self.assertEqual(r.status_code, 403, origin)
            self.assertNotIn("access-control-allow-origin", r.headers)
        # simple requests: the allowed origin may read 402s and 200s, and only X-PAYMENT-RESPONSE is exposed
        r = httpx.get(self.url(), headers={"Origin": ORIGIN})
        self.assertEqual(r.headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertEqual(r.headers["Access-Control-Expose-Headers"], "X-PAYMENT-RESPONSE")
        r = httpx.get(self.url(), headers={"Origin": ORIGIN, **self.sign(BUYER_KEY)})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertIn("X-PAYMENT-RESPONSE", r.headers)
        r = httpx.get(self.url(), headers={"Origin": "https://evil.example"})
        self.assertNotIn("access-control-allow-origin", r.headers)
        self.assertNotIn("access-control-expose-headers", r.headers)
        # errors raised before routing still carry CORS for the allowed origin
        r = httpx.request("GET", self.url(), headers={"Origin": ORIGIN}, content=b"body")
        self.assertEqual(r.status_code, 413)
        self.assertEqual(r.headers["Access-Control-Allow-Origin"], ORIGIN)

    def test_17_rate_limiting(self):
        _, base, _ = self.serve_temp(self.make_app(rate=0.2, burst=3))
        codes = [httpx.get(self.url(base=base)).status_code for _ in range(3)]
        self.assertEqual(codes, [402, 402, 402])
        r = httpx.get(self.url(base=base), headers={"Origin": ORIGIN, "X-Forwarded-For": "198.51.100.1"})
        self.assertEqual(r.status_code, 429)  # X-Forwarded-For from an untrusted peer is ignored
        self.assertGreaterEqual(int(r.headers["Retry-After"]), 1)
        self.assertEqual(r.json()["error"], "rate limited")
        self.assertEqual(r.headers["Access-Control-Allow-Origin"], ORIGIN)
        # behind a trusted proxy, buckets are per original client
        _, base, _ = self.serve_temp(self.make_app(rate=0.2, burst=2, trusted_proxies={"127.0.0.1"}))
        xff = lambda ip: {"X-Forwarded-For": f"10.9.9.9, {ip}"}  # noqa: E731 - left part is client-controlled
        self.assertEqual([httpx.get(self.url(base=base), headers=xff("203.0.113.7")).status_code for _ in range(3)],
                         [402, 402, 429])
        self.assertEqual(httpx.get(self.url(base=base), headers=xff("203.0.113.8")).status_code, 402)
        # the limiter's memory is bounded
        lim = server.RateLimiter(rate=1, burst=1, max_keys=100)
        for i in range(1000):
            lim.take(f"k{i}")
        self.assertLessEqual(len(lim._b), 100)

    def test_18_oversized_and_malformed_requests(self):
        r = raw_request(self.port, b"GET /" + b"a" * 5000 + b" HTTP/1.1\r\nHost: x\r\n\r\n")
        self.assertEqual(status_of(r), 414)
        self.assertEqual(body_of(r), {"error": "request line too long"})
        big = b"".join(b"X-Pad-%d: %s\r\n" % (i, b"p" * 1000) for i in range(20))
        r = raw_request(self.port, b"GET / HTTP/1.1\r\nHost: x\r\n" + big + b"\r\n")
        self.assertEqual(status_of(r), 431)
        r = raw_request(self.port, b"GET / HTTP/1.1\r\nX-Long: " + b"p" * 20000 + b"\r\n\r\n")
        self.assertEqual(status_of(r), 431)
        r = httpx.request("GET", self.url(), content=b"x" * 100_000)
        self.assertEqual(r.status_code, 413)
        r = raw_request(self.port, b"GET / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n")
        self.assertEqual(status_of(r), 413)
        r = httpx.post(self.url())
        self.assertEqual((r.status_code, r.headers["Allow"]), (405, "GET, OPTIONS"))
        r = httpx.head(self.url())
        self.assertEqual((r.status_code, r.content), (405, b""))
        self.assertEqual(status_of(raw_request(self.port, b"HELLO\r\n\r\n")), 400)
        self.assertEqual(status_of(raw_request(self.port, b"GET / HTTP/2.0\r\n\r\n")), 505)
        self.assertEqual(httpx.get(f"{self.base}/").status_code, 200)  # server still healthy

    def test_19_slowloris_is_cut_off_at_the_head_deadline(self):
        httpd, base, port = self.serve_temp(self.make_app(head_timeout=1.0, io_timeout=5.0))
        s = socket.create_connection(("127.0.0.1", port), timeout=5)
        stop = threading.Event()

        def trickle():
            try:
                s.sendall(b"GET / HTTP/1.1\r\n")
                while not stop.wait(0.2):
                    s.sendall(b"X-a: b\r\n")  # each byte arrives well within the per-recv timeout
            except OSError:
                pass
        t0 = time.monotonic()
        threading.Thread(target=trickle, daemon=True).start()
        data = b""
        try:
            while True:
                c = s.recv(4096)
                if not c:
                    break
                data += c
        except (ConnectionResetError, socket.timeout):
            pass
        stop.set()
        s.close()
        self.assertLess(time.monotonic() - t0, 3.5)
        self.assertEqual(status_of(data), 408)

    def test_20_connection_caps(self):
        def wait_idle(httpd):
            for _ in range(100):
                if httpd.active_connections == 0:
                    return
                time.sleep(0.05)
            self.fail("connections not released")

        for limits, expected in ((dict(max_conns=10, max_conns_per_ip=2), 429), (dict(max_conns=2, max_conns_per_ip=5), 503)):
            httpd, base, port = self.serve_temp(self.make_app(head_timeout=5.0, **limits))
            idle = [socket.create_connection(("127.0.0.1", port)) for _ in range(2)]
            for _ in range(100):
                if httpd.active_connections == 2:
                    break
                time.sleep(0.02)
            extra = socket.create_connection(("127.0.0.1", port), timeout=3)
            resp = b""
            while c := extra.recv(4096):
                resp += c
            extra.close()
            self.assertEqual(status_of(resp), expected)
            for s in idle:
                s.close()
            wait_idle(httpd)
            self.assertEqual(httpx.get(f"{base}/").status_code, 200)

    def test_21_caches_are_single_flight_and_bounded_by_ttl(self):
        app = self.make_app(data_ttl=60, quote_ttl=60)
        _, base, _ = self.serve_temp(app)
        before = self.provider_calls
        for _ in range(3):
            self.assertEqual(httpx.get(self.url(base=base), headers=self.sign(BUYER_KEY, host=base[7:])).status_code, 200)
        self.assertEqual(self.provider_calls - before, 1)
        cache, calls = server.TTLCache(), []

        def slow():
            calls.append(1)
            time.sleep(0.2)
            return 42
        threads = [threading.Thread(target=cache.get, args=("k", 60, slow)) for _ in range(10)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(len(calls), 1)
        self.assertEqual(cache.get("k", 60, slow), 42)
        self.assertEqual(server.TTLCache().get("k", 0, lambda: 7), 7)

    def test_22_json_logs_never_contain_credentials(self):
        buf = io.StringIO()
        app = self.make_app(log=server.Logger(True, stream=buf))
        _, base, port = self.serve_temp(app)
        host = f"127.0.0.1:{port}"
        hdr = self.sign(BUYER_KEY, host=host)
        xp = client.x_payment_header(BUYER_KEY, CHAIN, self.addr, 1, client.current_nonce(), host)
        self.assertEqual(httpx.get(self.url(base=base) + "?token=hunter2").status_code, 402)
        self.assertEqual(httpx.get(self.url(base=base), headers=hdr).status_code, 200)
        self.assertEqual(httpx.get(self.url(base=base), headers={**xp, "User-Agent": "agent/1.0"}).status_code, 200)
        text = buf.getvalue()
        recs = [json.loads(line) for line in text.splitlines()]
        reqs = [r for r in recs if r["event"] == "request"]
        self.assertEqual([r["status"] for r in reqs], [402, 200, 200])
        for rec in reqs:
            self.assertTrue({"ts", "level", "event", "ip", "method", "path", "status", "ms", "resource_id"} <= set(rec))
            self.assertEqual(rec["path"], "/api/polymarket-rewards")
        self.assertEqual(reqs[1]["address"], self.buyer.address)
        for secret in (hdr["X-PayGate-Signature"], hdr["X-PayGate-Signature"][2:], xp["X-PAYMENT"], "hunter2"):
            self.assertNotIn(secret, text)
        # RPC credentials are scrubbed from log lines
        buf2 = io.StringIO()
        server.Logger(True, stream=buf2, scrub=("https://rpc.example/v2/SECRETKEY",)).emit(
            "error", "x", error="HTTPError for url https://rpc.example/v2/SECRETKEY")
        self.assertNotIn("SECRETKEY", buf2.getvalue())

    # ------------------------------------------------------------------ client safety

    def test_23_client_does_not_double_pay_when_server_lags(self):
        key, who = self.fresh_buyer()
        self.pay_direct(key, 1)  # access already on-chain
        for lag, ok in ((3, True), (10**6, False)):
            app = self.make_app()
            real, seen = app.access, []

            def lagging(addr, rid, real=real, seen=seen, lag=lag):
                seen.append(1)
                return (0, 0) if len(seen) <= lag else real(addr, rid)
            app.access = lagging
            _, base, _ = self.serve_temp(app)
            nonce = self.nonce_of(who)
            if ok:
                self.assertEqual(self.fetch(self.url(base=base), key, backoff=0.05)["data"], STUB)
            else:
                with self.assertRaisesRegex(client.PayGateError, "holds on-chain access"):
                    self.fetch(self.url(base=base), key, retries=2, backoff=0.05)
            self.assertEqual(self.nonce_of(who), nonce)

    def test_24_concurrent_fetches_pay_once(self):
        key, who = self.fresh_buyer()
        results, errors = [], []

        def run():
            try:
                results.append(self.fetch(self.url(), key, backoff=0.1))
            except Exception as e:  # noqa: BLE001
                errors.append(e)
        threads = [threading.Thread(target=run) for _ in range(3)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 3)
        self.assertEqual(self.nonce_of(who), 1)  # exactly one payment

    def test_25_fee_cap_simulation_and_chain_pinning(self):
        key, who = self.fresh_buyer()
        with self.assertRaisesRegex(client.PayGateError, "worst-case gas fee"):
            client.pay(self.w3, key, self.addr, 1, PRICE, WINDOW, 10**18, max_fee_wei=1)
        broke = Account.create()
        with self.assertRaisesRegex(client.PayGateError, "simulation failed"):
            client.pay(self.w3, Web3.to_hex(broke.key), self.addr, 1, PRICE, WINDOW, 10**18)
        self.assertEqual((self.nonce_of(who), self.nonce_of(broke.address)), (0, 0))
        h = client.pay(self.w3, key, self.addr, 1, PRICE, WINDOW, 10**18, chain_id=CHAIN)
        self.assertEqual(self.w3.eth.get_transaction(h)["chainId"], CHAIN)
        self.assertEqual(client.onchain_remaining(self.w3, self.addr, who, 1),
                         self.gate.functions.remaining(who, 1).call())

    def test_26_client_input_and_response_limits(self):
        class Big(BaseHTTPRequestHandler):
            body = b"{}"

            def do_GET(self):
                self.send_response(402)
                self.send_header("Content-Length", str(len(Big.body)))
                self.end_headers()
                try:
                    self.wfile.write(Big.body)
                except OSError:
                    pass  # the client hung up on purpose

            def log_message(self, *a):
                pass
        srv = ThreadingHTTPServer(("127.0.0.1", 0), Big)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        u = f"http://127.0.0.1:{srv.server_address[1]}/api/x"
        Big.body = b'{"a":"' + b"x" * 2_000_000 + b'"}'
        with self.assertRaisesRegex(client.PayGateError, "limit"):
            self.fetch(u, BUYER_KEY, max_response_bytes=1_000_000)
        Big.body = b"<html>\x1b[2Jpay me</html>"
        with self.assertRaisesRegex(client.PayGateError, "not a JSON object"):
            self.fetch(u, BUYER_KEY)
        # URLs we send signatures to
        for bad in ("http://example.com/api/x", "ftp://127.0.0.1/x", "https://user:pw@example.com/x", "http:///x"):
            with self.assertRaises(client.PayGateError, msg=bad):
                client.check_url(bad)
        self.assertEqual(client.check_url("http://example.com:8080/x", allow_http=True), "example.com:8080")
        self.assertEqual(client.check_url("http://localhost:8402/api/x"), "localhost:8402")
        # client and server agree on host normalization and on the message
        for u, want in (("http://127.0.0.1:8402/x", "127.0.0.1:8402"), ("https://API.Example.com:443/a", "api.example.com"),
                        ("http://example.com:80/", "example.com"), ("https://example.com:80/", "example.com:80"),
                        ("https://[::1]:8443/", "[::1]:8443"), ("https://bücher.example/x", "xn--bcher-kva.example")):
            self.assertEqual(client.url_host(u), want, u)
            self.assertEqual(server.normalize_host(u), want, u)
        for bad in ("a b", "evil.example/path", "user@host", "", "host:99999"):
            self.assertIsNone(server.normalize_host(bad), bad)
        self.assertEqual(client.auth_message(1, "0xAbC", 2, 3, "Host:1"), server.auth_message(1, "0xAbC", 2, 3, "Host:1"))
        # USDC amounts are exact
        for text, wei in (("0.01", 10**16), ("1", 10**18), ("0", 0), ("1e-18", 1),
                          ("79228162514.264337593543950335", 79228162514264337593543950335)):
            self.assertEqual(client.parse_usdc(text), wei)
            self.assertEqual(client.parse_usdc(client.format_usdc(wei)), wei)
        for bad in ("0.0000000000000000001", "-1", "abc", "NaN", "Infinity", ""):
            with self.assertRaises(ValueError, msg=bad):
                client.parse_usdc(bad)
        self.assertEqual(server.usdc(1), "0.000000000000000001")
        self.assertEqual(server.usdc(5 * 10**18), "5")
        # we never sign a bucket later than our own clock, so a server running ahead cannot
        # stretch a signature's lifetime
        good = httpx.get(self.url()).json()
        local = client.current_nonce()
        for server_nonce, signed in ((local + 1, local), (local - 1, local - 1), (local, local)):
            ins = {**good, "auth": {**good["auth"], "nonce": server_nonce,
                                    "message": client.auth_message(CHAIN, self.addr, 1, server_nonce, self.host)}}
            self.assertEqual(client.validate_instructions(ins, CHAIN, self.addr, host=self.host)["nonce"], signed)

    def test_27_client_backs_off_on_429(self):
        _, base, _ = self.serve_temp(self.make_app(rate=2, burst=1))
        logs = []
        t0 = time.monotonic()
        out = self.fetch(self.url(base=base), BUYER_KEY, log=logs.append)
        self.assertEqual(out["data"], STUB)
        self.assertTrue(any("rate limited" in m for m in logs))
        self.assertLess(time.monotonic() - t0, 10)

    # ------------------------------------------------------------------ CLIs

    def cli(self, *args, key=None, env_extra=None, timeout=120):
        env = {k: v for k, v in os.environ.items() if not k.startswith("PAYGATE_") and k != "EVM_PRIVATE_KEY"}
        env.update({"PAYGATE_RPC": self.rpc, "PAYGATE_CHAIN_ID": str(CHAIN), "PAYGATE_ADDR": self.addr,
                    "PAYGATE_LOCK_DIR": self.lock_dir})
        if key:
            env["EVM_PRIVATE_KEY"] = key
        for k, v in (env_extra or {}).items():
            if v is None:
                env.pop(k, None)
            else:
                env[k] = v
        return subprocess.Popen([sys.executable, os.path.join(HERE, "client.py"), *args], env=env, cwd=HERE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def run_cli(self, *args, **kw):
        p = self.cli(*args, **kw)
        out, err = p.communicate(timeout=120)
        return p.returncode, out, err

    def test_28_client_cli(self):
        key, who = self.fresh_buyer()
        code, out, err = self.run_cli("quote", self.url(), "--json", key=key)
        self.assertEqual(code, 0, err)
        q = json.loads(out)
        self.assertEqual((q["price_usdc"], q["window_seconds"], q["matches_chain"], q["pinned"]), ("0.01", WINDOW, True, True))
        self.assertEqual((q["address"], q["remaining_seconds"]), (who, 0))
        code, out, err = self.run_cli("quote", self.url())
        self.assertEqual(code, 0, err)
        self.assertIn("0.01 USDC", out)

        code, out, err = self.run_cli("fetch", self.url(), "--max-usdc", "0.001", key=key)
        self.assertEqual(code, 1)
        self.assertIn("spend cap", err)
        self.assertEqual(self.nonce_of(who), 0)
        code, out, err = self.run_cli("fetch", self.url(), "--max-usdc", "abc", key=key)
        self.assertEqual(code, 2)
        code, out, err = self.run_cli("fetch", self.url(), key=key, env_extra={"PAYGATE_ADDR": None})
        self.assertEqual(code, 1)
        self.assertIn("no PayGate contract pinned", err)
        code, out, err = self.run_cli("fetch", self.url())
        self.assertEqual(code, 1)
        self.assertIn("no key", err)

        code, out, err = self.run_cli("fetch", self.url(), "--max-usdc", "0.05", key=key)
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["data"], STUB)
        self.assertIn("paid in tx", err)
        self.assertEqual(self.nonce_of(who), 1)
        # legacy positional form, key from a file; already paid, so no new tx
        with tempfile.NamedTemporaryFile("w", suffix=".key", delete=False) as fh:
            fh.write(key + "\n")
        self.addCleanup(os.unlink, fh.name)
        code, out, err = self.run_cli(self.url(), "--key-file", fh.name)
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["data"], STUB)
        self.assertEqual(self.nonce_of(who), 1)

        code, out, err = self.run_cli("discover", self.base, "--json")
        self.assertEqual(code, 0, err)
        self.assertIn(self.url(), [r["url"] for r in json.loads(out)["resources"]])

        # two processes racing for the same (payer, resource) pay exactly once
        key2, who2 = self.fresh_buyer()
        procs = [self.cli("fetch", self.url(), key=key2) for _ in range(2)]
        outs = [p.communicate(timeout=120) for p in procs]
        self.assertEqual([p.returncode for p in procs], [0, 0], outs)
        self.assertEqual(self.nonce_of(who2), 1)

    def test_29_server_preflight_config_and_cli(self):
        ok = self.make_app(resources={"polymarket-rewards": 1})
        self.assertEqual([q.rid for q in ok.preflight()], [1])
        for app, err in ((self.make_app(chain_id=1, resources={"polymarket-rewards": 1}), "is chain"),
                         (self.make_app(addr=Account.create().address, resources={"x": 1}), "no contract code"),
                         (self.make_app(resources={"ghost": 99}), "does not exist"),
                         (self.make_app(seller=Account.create().address, resources={"polymarket-rewards": 1}), "owned by"),
                         (self.make_app(resources={"polymarket-rewards": 1}, providers={"other": lambda: 1}), "no data provider")):
            with self.assertRaisesRegex(server.StartupError, err):
                app.preflight()
        # configuration parsing
        with self.assertRaises(ValueError):
            server.Config.from_env({})
        cfg = server.Config.from_env({"PAYGATE_ADDR": self.addr.lower(), "PAYGATE_PUBLIC_HOST": "https://API.example.com:443",
                                      "PAYGATE_CORS_ORIGINS": "https://a.example/, https://b.example",
                                      "PAYGATE_TRUSTED_PROXIES": "127.0.0.1, ::1", "PAYGATE_LOG_JSON": "1"})
        self.assertEqual((cfg.addr, cfg.public_host, cfg.public_scheme), (self.addr, "api.example.com", "https"))
        self.assertEqual(cfg.cors_origins, ("https://a.example", "https://b.example"))
        self.assertEqual(cfg.trusted_proxies, frozenset({"127.0.0.1", "::1"}))
        self.assertTrue(cfg.json_logs)
        cfg = server.Config.from_env({"PAYGATE_ADDR": self.addr, "PAYGATE_PUBLIC_HOST": "http://api.example.com:8080"})
        self.assertEqual((cfg.public_host, cfg.public_scheme), ("api.example.com:8080", "http"))
        for bad in ({"PAYGATE_PUBLIC_HOST": "a b"}, {"PAYGATE_SELLER": "0x12"}, {"PAYGATE_ADDR": "nope"}):
            with self.assertRaises(ValueError, msg=bad):
                server.Config.from_env({"PAYGATE_ADDR": self.addr, **bad})
        self.assertEqual(server.redact_url("https://user:pw@rpc.example.com/v2/KEY?x=1"), "https://rpc.example.com/...")

        # the real entry point: startup checks, JSON logs, discovery, 402
        env = {k: v for k, v in os.environ.items() if not k.startswith("PAYGATE_")}
        env.update({"PAYGATE_RPC": self.rpc, "PAYGATE_CHAIN_ID": str(CHAIN), "PAYGATE_ADDR": self.addr,
                    "PAYGATE_DEMO_ID": "1", "PAYGATE_SELLER": self.seller})
        port = free_port()
        p = subprocess.Popen([sys.executable, os.path.join(HERE, "server.py"), "--host", "127.0.0.1",
                              "--port", str(port), "--json"], env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True)
        try:
            for _ in range(150):
                try:
                    if httpx.get(f"http://127.0.0.1:{port}/").status_code == 200:
                        break
                except httpx.HTTPError:
                    time.sleep(0.1)
            d = httpx.get(f"http://127.0.0.1:{port}/.well-known/paygate.json").json()
            self.assertEqual([r["resource_id"] for r in d["resources"]], [1])
            self.assertEqual(httpx.get(f"http://127.0.0.1:{port}/api/polymarket-rewards").status_code, 402)
        finally:
            p.terminate()
            _, err = p.communicate(timeout=10)
        events = [json.loads(line)["event"] for line in err.splitlines()]
        for ev in ("resource", "no_public_host", "listening", "request"):
            self.assertIn(ev, events)
        # and it refuses to start on a misconfiguration
        r = subprocess.run([sys.executable, os.path.join(HERE, "server.py"), "--port", str(free_port())],
                           env={**env, "PAYGATE_CHAIN_ID": "5042"}, capture_output=True, text=True, timeout=60)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("startup check failed", r.stderr)

    def test_30_abi_json_matches_the_deployed_contract(self):
        """py/abi.json (server) and the client's minimal ABI must agree with the contract on every
        function they call; a drift would surface as a revert or a mis-decoded quote in production."""
        with open(ARTIFACT) as fh:
            art = {x["name"]: x for x in json.load(fh)["abi"] if x["type"] == "function"}
        mine = {x["name"]: x for x in server.ABI if x["type"] == "function"}
        for name in ("quote", "remaining", "accessUntil", "MAX_PAGE", "pay"):
            self.assertEqual(mine[name], art[name], name)
        def strip(fn):
            return [i["type"] for i in fn["inputs"]], [o["type"] for o in fn["outputs"]]
        for f in client.ABI:
            self.assertEqual(strip(f), strip(art[f["name"]]), f["name"])
            self.assertEqual(f["stateMutability"], art[f["name"]]["stateMutability"], f["name"])


if __name__ == "__main__":
    unittest.main()
