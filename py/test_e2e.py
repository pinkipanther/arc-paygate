"""End-to-end test of the 402 flow against a local anvil chain.

    cd py && ../../.venv/bin/python -m unittest -v test_e2e      (needs `anvil` and `forge build`)

Deploys PayGate from the forge artifact, runs server.py in-process with the demo data provider
stubbed, and drives client.py through 402 -> pay -> 200, plus the paths a hostile or broken
server would exercise.
"""
import importlib
import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

import httpx
from eth_account import Account
from web3 import Web3

HERE = os.path.dirname(os.path.abspath(__file__))
ARTIFACT = os.path.join(HERE, "..", "out", "PayGate.sol", "PayGate.json")
# anvil's default funded accounts (test keys only; chain id 31337)
SELLER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
BUYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
PRICE = 10**16  # 0.01 "USDC"
WINDOW = 3600


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


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
        art = json.load(open(ARTIFACT))
        seller = Account.from_key(SELLER_KEY)
        cls.w3.eth.default_account = seller.address
        c = cls.w3.eth.contract(abi=art["abi"], bytecode=art["bytecode"]["object"])
        rcpt = cls.w3.eth.wait_for_transaction_receipt(c.constructor().transact())
        cls.addr = rcpt["contractAddress"]
        cls.gate = cls.w3.eth.contract(address=cls.addr, abi=art["abi"])
        cls.w3.eth.wait_for_transaction_receipt(cls.gate.functions.createResource(PRICE, WINDOW, "demo").transact())
        cls.w3.eth.wait_for_transaction_receipt(cls.gate.functions.createResource(PRICE, WINDOW, "paused").transact())
        cls.w3.eth.wait_for_transaction_receipt(
            cls.gate.functions.updateResource(2, PRICE, WINDOW, False, "paused").transact())

        os.environ.update({"PAYGATE_RPC": cls.rpc, "PAYGATE_CHAIN_ID": "31337", "PAYGATE_ADDR": cls.addr,
                           "PAYGATE_DEMO_ID": "1"})
        sys.path.insert(0, HERE)
        cls.server = importlib.import_module("server")
        cls.client = importlib.import_module("client")
        cls.server.RESOURCES["paused"] = 2
        cls.server.RESOURCES["ghost"] = 99
        cls.server.PROVIDERS["polymarket-rewards"] = lambda: {"pools": [{"condition_id": "0xabc"}]}
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), cls.server.H)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.buyer = Account.from_key(BUYER_KEY)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.anvil.terminate()
        cls.anvil.wait()

    def url(self, name="polymarket-rewards"):
        return f"{self.base}/api/{name}"

    def test_01_unauthenticated_402_has_bound_message(self):
        r = httpx.get(self.url())
        self.assertEqual(r.status_code, 402)
        ins = r.json()
        self.assertEqual(ins["chain_id"], 31337)
        self.assertEqual(ins["contract"], self.addr)
        self.assertEqual(ins["price_wei"], str(PRICE))
        self.assertEqual(ins["price_usdc"], "0.01")
        self.assertEqual(ins["auth"]["message"],
                         f"paygate:31337:{self.addr.lower()}:1:{ins['auth']['nonce']}")
        self.assertEqual(r.headers["Cache-Control"], "no-store")
        # calldata advertised is pay(1, WINDOW), i.e. carries the minWindow guard
        self.assertEqual(ins["pay_calldata"], self.gate.encode_abi("pay", [1, WINDOW]))

    def test_02_full_flow_pays_once_then_reuses_access(self):
        before = self.w3.eth.get_balance(self.buyer.address)
        out = self.client.fetch(self.url(), BUYER_KEY, self.rpc, chain_id=31337, pinned_contract=self.addr)
        self.assertEqual(out["data"], {"pools": [{"condition_id": "0xabc"}]})
        self.assertTrue(self.gate.functions.hasAccess(self.buyer.address, 1).call())
        self.assertEqual(self.gate.functions.balances(Account.from_key(SELLER_KEY).address).call(), PRICE)
        spent = before - self.w3.eth.get_balance(self.buyer.address)
        self.assertGreaterEqual(spent, PRICE)
        nonce = self.w3.eth.get_transaction_count(self.buyer.address)
        # second fetch: signature only, no new transaction
        out2 = self.client.fetch(self.url(), BUYER_KEY, self.rpc, chain_id=31337, pinned_contract=self.addr)
        self.assertEqual(out2["access_until"], out["access_until"])
        self.assertEqual(self.w3.eth.get_transaction_count(self.buyer.address), nonce)

    def test_03_bad_signature_is_401_and_client_does_not_pay(self):
        ins = httpx.get(self.url()).json()
        other = Account.create()
        hdr = self.client.auth_headers(other.key, 31337, self.addr, 1, ins["auth"]["nonce"])
        hdr["X-PayGate-Address"] = self.buyer.address  # claim buyer's address with another key
        self.assertEqual(httpx.get(self.url(), headers=hdr).status_code, 401)
        # a signature for another contract / chain / resource / stale bucket is rejected
        for args in ((1, self.addr, 1, ins["auth"]["nonce"]), (31337, Account.create().address, 1, ins["auth"]["nonce"]),
                     (31337, self.addr, 2, ins["auth"]["nonce"]), (31337, self.addr, 1, ins["auth"]["nonce"] - 2)):
            self.assertEqual(httpx.get(self.url(), headers=self.client.auth_headers(BUYER_KEY, *args)).status_code, 401)
        # previous bucket is still accepted (5-minute boundary tolerance)
        hdr = self.client.auth_headers(BUYER_KEY, 31337, self.addr, 1, ins["auth"]["nonce"] - 1)
        self.assertEqual(httpx.get(self.url(), headers=hdr).status_code, 200)

    def test_04_malformed_credentials_are_400_without_rpc(self):
        self.assertEqual(httpx.get(self.url(), headers={"X-PayGate-Address": "nope", "X-PayGate-Signature": "0x00"}).status_code, 400)
        self.assertEqual(httpx.get(self.url(), headers={"X-PayGate-Address": self.buyer.address}).status_code, 400)
        self.assertEqual(httpx.get(self.url(), headers={"X-PayGate-Address": self.buyer.address,
                                                        "X-PayGate-Signature": "0x" + "zz" * 65}).status_code, 400)

    def test_05_unknown_paused_and_ghost_resources(self):
        self.assertEqual(httpx.get(self.url("nothing")).status_code, 404)
        self.assertEqual(httpx.get(self.url("paused")).status_code, 503)
        self.assertEqual(httpx.get(self.url("ghost")).status_code, 404)

    def test_06_provider_failure_is_502_json(self):
        def boom():
            raise RuntimeError("upstream down")
        orig = self.server.PROVIDERS["polymarket-rewards"]
        self.server.PROVIDERS["polymarket-rewards"] = boom
        try:
            ins = httpx.get(self.url()).json()
            r = httpx.get(self.url(), headers=self.client.auth_headers(BUYER_KEY, 31337, self.addr, 1, ins["auth"]["nonce"]))
            self.assertEqual(r.status_code, 502)
            self.assertEqual(r.json(), {"error": "upstream error"})
        finally:
            self.server.PROVIDERS["polymarket-rewards"] = orig

    def test_07_client_rejects_malicious_402_without_transacting(self):
        good = httpx.get(self.url()).json()
        nonce = self.w3.eth.get_transaction_count(self.buyer.address)
        attacker = Account.create().address
        cases = {
            "wrong contract": {**good, "contract": attacker},
            "wrong chain": {**good, "chain_id": 1},
            "wrong scheme": {**good, "scheme": "send-me-eth"},
            "foreign message": {**good, "auth": {**good["auth"], "message": "login to exchange"}},
            "message for other contract": {**good, "auth": {**good["auth"], "message": f"paygate:31337:{attacker.lower()}:1:{good['auth']['nonce']}"}},
            "future nonce": {**good, "auth": {**good["auth"], "nonce": good["auth"]["nonce"] + 10,
                                              "message": f"paygate:31337:{self.addr.lower()}:1:{good['auth']['nonce'] + 10}"}},
            "garbage price": {**good, "price_wei": "lots"},
        }
        for name, ins in cases.items():
            with self.assertRaises(self.client.PayGateError, msg=name):
                self.client.validate_instructions(ins, 31337, self.addr)
        # pinned contract mismatch
        with self.assertRaises(self.client.PayGateError):
            self.client.validate_instructions(good, 31337, attacker)
        # inflated price / overlong window promise / spend cap: refused before any tx
        for kw in (dict(price=PRICE * 2, window=WINDOW), dict(price=PRICE, window=WINDOW * 2)):
            with self.assertRaises(self.client.PayGateError):
                self.client.pay(self.w3, BUYER_KEY, self.addr, 1, max_wei=10**18, **kw)
        with self.assertRaises(self.client.PayGateError):
            self.client.pay(self.w3, BUYER_KEY, self.addr, 1, PRICE, WINDOW, max_wei=PRICE - 1)
        with self.assertRaises(self.client.PayGateError):
            self.client.pay(self.w3, BUYER_KEY, self.addr, 2, PRICE, WINDOW, max_wei=10**18)  # inactive
        self.assertEqual(self.w3.eth.get_transaction_count(self.buyer.address), nonce)

    def test_08_client_does_not_pay_on_401_or_5xx(self):
        # A server that answers 500 to the signed request must not trigger a payment.
        class Flaky(self.server.H):
            def _get(self):
                if self.headers.get("X-PayGate-Signature"):
                    return self._json(500, {"error": "boom"})
                return super()._get()
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Flaky)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            nonce = self.w3.eth.get_transaction_count(self.buyer.address)
            with self.assertRaises(self.client.PayGateError):
                self.client.fetch(f"http://127.0.0.1:{httpd.server_address[1]}/api/polymarket-rewards", BUYER_KEY,
                                  self.rpc, chain_id=31337, pinned_contract=self.addr)
            self.assertEqual(self.w3.eth.get_transaction_count(self.buyer.address), nonce)
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
