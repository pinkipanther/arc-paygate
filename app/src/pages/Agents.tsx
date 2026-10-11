import { CodeTabs } from "../components/CodeTabs";
import { ExtLink } from "../components/ui";
import { REPO } from "../config";
import { useApp } from "../lib/store";

export function Agents() {
  const { net } = useApp();
  const c = net.contract ?? "0x<PayGate>";
  const chain = net.chain.id;

  const four02 = `HTTP/1.1 402 Payment Required
Content-Type: application/json
Cache-Control: no-store

{
  "x402Version": 1,
  "error": "PAYMENT_REQUIRED",
  "accepts": [{
    "scheme": "exact-native",
    "network": "eip155:${chain}",
    "maxAmountRequired": "10000000000000000",
    "asset": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    "payTo": "${c}",
    "resource": "https://api.example.com/api/polymarket-rewards",
    "extra": { "name": "USDC", "decimals": 18, "paygate": { "resource_id": 1, "window_seconds": 3600, "pay": "pay(uint256,uint32)" } }
  }],
  "scheme": "paygate-native-v2",
  "chain_id": ${chain},
  "contract": "${c}",
  "resource_id": 1,
  "price_wei": "10000000000000000",
  "price_usdc": "0.01",
  "window_seconds": 3600,
  "discovery": "/.well-known/paygate.json",
  "auth": {
    "message_format": "paygate:2:<chain_id>:<contract_lowercase>:<resource_id>:<nonce>:<host_lowercase>",
    "nonce": 5972140,
    "host": "api.example.com",
    "message": "paygate:2:${chain}:${c.toLowerCase()}:1:5972140:api.example.com"
  }
}`;

  const retry = `GET /api/polymarket-rewards HTTP/1.1
Host: api.example.com
X-PayGate-Address: 0xYourAgent
X-PayGate-Signature: 0x<EIP-191 signature of the auth.message>

HTTP/1.1 200 OK
X-PAYMENT-RESPONSE: <base64 {"success":true,"network":"eip155:${chain}","payer":"0x…","accessUntil":1791739200}>
{ "resource": "polymarket-rewards", "access_until": 1791739200, "data": { … } }

# x402-style alternative to the two headers (send one or the other, not both):
X-PAYMENT: <base64 {"x402Version":1,"scheme":"exact-native","network":"eip155:${chain}",
                    "payload":{"from":"0x…","signature":"0x…","nonce":5972140}}>`;

  return (
    <div className="wrap" style={{ maxWidth: 920 }}>
      <div className="page-h">
        <div>
          <h1>Integrate PayGate</h1>
          <p>Everything an agent or a seller's server needs: the 402 response, the signature, the contract calls and what each error means.</p>
        </div>
        <ExtLink href={REPO}>Source on GitHub</ExtLink>
      </div>

      <div className="stack" style={{ gap: 28 }}>
        <section className="card">
          <div className="card-h">
            <h3>1 · Ask, and read the 402</h3>
          </div>
          <div className="card-b stack">
            <p className="ink2">An unpaid request gets HTTP 402. The body names the chain, the contract, the resource id and the terms. Treat it as a claim: the client re-reads the same numbers from the contract before paying.</p>
            <pre className="code">{four02}</pre>
            <p className="muted" style={{ fontSize: "0.86rem" }}>
              The <span className="mono">accepts</span> array is an x402-shaped envelope so x402-aware agents can parse the offer. The scheme name <span className="mono">exact-native</span> is PayGate's own: payment is a native-USDC <span className="mono">pay()</span> call, not an EIP-3009 authorization.
            </p>
          </div>
        </section>

        <section className="card">
          <div className="card-h">
            <h3>2 · Pay once on Arc</h3>
          </div>
          <div className="card-b stack">
            <p className="ink2">
              Call <span className="mono">pay(resourceId, minWindow)</span> on the contract with <span className="mono">value = price</span>. Native USDC uses 18 decimals in <span className="mono">msg.value</span>. Pass the window you were quoted as <span className="mono">minWindow</span>; the call reverts if the seller shortened it. Paying while a pass is active extends it.
            </p>
            <CodeTabs
              tabs={[
                {
                  key: "viem",
                  label: "viem",
                  plain: `const quote = await client.readContract({ address: "${c}", abi, functionName: "quote", args: [1n] });\n// quote = [price, window, seller, active, uri]\nawait wallet.writeContract({\n  address: "${c}", abi, functionName: "pay",\n  args: [1n, quote[1]],      // minWindow = the window you were quoted\n  value: quote[0],           // exactly the price, 18 decimals\n});`,
                },
                {
                  key: "cast",
                  label: "cast",
                  plain: `cast send ${c} "pay(uint256,uint32)" 1 3600 \\\n  --value 0.01ether --rpc-url ${net.walletRpc} --private-key $KEY\n# "ether" here means 1e18 base units, i.e. 0.01 USDC on Arc`,
                },
                {
                  key: "py",
                  label: "Python client",
                  plain: `python py/client.py quote https://api.example.com/api/polymarket-rewards --contract ${c}\npython py/client.py fetch https://api.example.com/api/polymarket-rewards --contract ${c} --max-usdc 0.05\npython py/client.py discover https://api.example.com`,
                },
              ]}
            />
          </div>
        </section>

        <section className="card">
          <div className="card-h">
            <h3>3 · Prove it and read</h3>
          </div>
          <div className="card-b stack">
            <p className="ink2">
              Sign the message with EIP-191 <span className="mono">personal_sign</span> and retry with two headers. The message binds the chain, contract, resource, a five-minute time bucket and the server's host, so a signature captured by one server is useless at another.
            </p>
            <pre className="code">{retry}</pre>
          </div>
        </section>

        <section className="card">
          <div className="card-h">
            <h3>Contract reference</h3>
          </div>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Function</th>
                  <th>Who</th>
                  <th style={{ whiteSpace: "normal" }}>What it does</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["quote(id)", "anyone", "Price, window, seller, on-sale flag and listing details."],
                  ["pay(id, minWindow)", "buyer", "Exact price as value; extends your pass by the window."],
                  ["payFor(id, who, minWindow)", "anyone", "Same, but the pass belongs to another address (e.g. an agent key)."],
                  ["hasAccess(who, id)", "server", "True while the pass is valid. The only on-chain check a server needs."],
                  ["remaining(who, id)", "anyone", "Seconds left on a pass."],
                  ["getResources(from, limit)", "anyone", "Paged listing for frontends; use limit ≤ 25."],
                  ["createResource(price, window, uri)", "seller", "List a resource; window between 1 second and 365 days."],
                  ["updateResource(id, …)", "seller", "Reprice, resize, pause or edit. Never revokes passes already sold."],
                  ["transferResource(id, to)", "seller", "Hand future sales to another address."],
                  ["withdraw() / withdrawTo(to)", "seller", "Pull your USDC. No fees, no owner."],
                ].map(([f, w, d]) => (
                  <tr key={f}>
                    <td className="mono">{f}</td>
                    <td>{w}</td>
                    <td style={{ whiteSpace: "normal" }}>{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <div className="card-h">
            <h3>Errors</h3>
          </div>
          <div className="tablewrap">
            <table className="table">
              <tbody>
                {[
                  ["WrongAmount(expected, got)", "Value didn't equal the current price. Re-read the quote."],
                  ["WindowTooShort(min, actual)", "The seller shortened the window after you were quoted."],
                  ["Inactive()", "Paused or never created."],
                  ["NotSeller()", "Only the listing's seller can change it."],
                  ["NothingToWithdraw()", "No balance to pull."],
                  ["TransferFailed()", "The destination refused USDC; use withdrawTo."],
                  ["UriTooLong / ZeroWindow / WindowTooLong / ZeroAddress", "Input validation."],
                ].map(([e, d]) => (
                  <tr key={e}>
                    <td className="mono">{e}</td>
                    <td style={{ whiteSpace: "normal" }}>{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="banner info" style={{ display: "block" }}>
          <b>What PayGate doesn't promise.</b> A pass is an on-chain entitlement for a time window, per address. There are no refunds and no delivery guarantee; serving the data is the seller's job. Anyone holding the key can use the pass, and sales figures can include a seller buying their own pass.
        </section>
      </div>
    </div>
  );
}
