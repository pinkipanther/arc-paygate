import { useMemo } from "react";
import { Exchange } from "../components/Exchange";
import { Pass } from "../components/Pass";
import { Arrow } from "../components/icons";
import { CodeTabs } from "../components/CodeTabs";
import { LatestPasses } from "../components/LatestPasses";
import { NotDeployed } from "../components/NotDeployed";
import { intFmt, usdc } from "../lib/format";
import { useAccess, useChainInfo, useResources, type Resource } from "../lib/hooks";
import { parseMeta } from "../lib/meta";
import { useApp } from "../lib/store";

const SAMPLE: Resource = {
  id: 1n,
  seller: "0x0000000000000000000000000000000000000000",
  price: 10_000_000_000_000_000n,
  window: 3600,
  active: true,
  sales: 0n,
  revenue: 0n,
  uri: "",
  meta: { ...parseMeta("https://api.example.com/api/polymarket-rewards", 1), name: "Polymarket reward pools" },
};

export function Home() {
  const { net, wallet } = useApp();
  const res = useResources();
  const chain = useChainInfo();
  const list = res.data ?? [];
  const featured = useMemo(() => {
    const live = list.filter((r) => r.active);
    return [...live].sort((a, b) => Number(b.sales - a.sales) || Number(a.id - b.id))[0] ?? null;
  }, [list]);
  const access = useAccess(featured?.id ?? null);
  const sold = list.reduce((a, r) => a + r.sales, 0n);
  const settled = list.reduce((a, r) => a + r.revenue, 0n);
  const gasPerPass = chain.gasPrice ? chain.gasPrice * 80_000n : null;

  return (
    <>
      <section className="wrap hero">
        <div>
          <span className="eyebrow">Native USDC on Arc</span>
          <h1>
            Sell API access by the hour. Buyers pay in <span className="hl">one transaction</span>.
          </h1>
          <p className="lede">
            PayGate is a paywall contract and an HTTP 402 server for people and AI agents. On Arc the gas token is USDC, so paying is a plain transfer: nothing to approve, no second token for gas, one balance for everything.
          </p>
          <div className="ctas">
            <a className="btn btn-primary btn-lg" href={featured ? `#/r/${featured.id}` : "#/market"}>
              {featured ? "Try a pass" : "Browse resources"}
              <Arrow />
            </a>
            <a className="btn btn-secondary btn-lg" href="#/sell">
              List your API
            </a>
          </div>
        </div>
        <div className="hero-stage">
          {net.contract ? (
            res.loading && !res.data ? (
              <div className="skel" style={{ height: 210, borderRadius: 20 }} />
            ) : featured ? (
              <>
                <a href={`#/r/${featured.id}`} style={{ color: "inherit", textDecoration: "none" }}>
                  <Pass r={featured} until={access.until} holder={wallet?.address} />
                </a>
                <p className="muted" style={{ fontSize: "0.86rem", textAlign: "center" }}>
                  {access.until * 1000 > Date.now() ? "You hold this pass. It counts down in real time." : "Live on " + net.label + ". Click the pass to buy it."}
                </p>
                <LatestPasses resources={list} />
              </>
            ) : (
              <>
                <Pass r={SAMPLE} until={0} preview />
                <p className="muted" style={{ fontSize: "0.86rem", textAlign: "center" }}>
                  Nothing is listed on {net.label} yet. <a href="#/sell">List the first resource.</a>
                </p>
              </>
            )
          ) : (
            <>
              <Pass r={SAMPLE} until={0} preview />
              <NotDeployed compact />
            </>
          )}
        </div>
      </section>

      <section className="wrap" style={{ paddingBottom: 56 }}>
        <div className="stats" aria-label="Live network figures">
          <div className="stat">
            <span className="eyebrow">Resources</span>
            <div className="v num">{net.contract && res.data ? intFmt(list.length) : "—"}</div>
            <div className="s">{net.contract && res.data ? `${list.filter((r) => r.active).length} on sale` : "listed on-chain"}</div>
          </div>
          <div className="stat">
            <span className="eyebrow">Passes sold</span>
            <div className="v num">{net.contract && res.data ? intFmt(sold) : "—"}</div>
            <div className="s">all time</div>
          </div>
          <div className="stat">
            <span className="eyebrow">USDC settled</span>
            <div className="v num">{net.contract && res.data ? usdc(settled) : "—"}</div>
            <div className="s">paid to sellers</div>
          </div>
          <div className="stat">
            <span className="eyebrow">Gas per pass</span>
            <div className="v num">{gasPerPass ? usdc(gasPerPass, 5) : "—"}</div>
            <div className="s">USDC at current price</div>
          </div>
          <div className="stat">
            <span className="eyebrow">{net.short} block</span>
            <div className="v num">{chain.block ? intFmt(chain.block) : "—"}</div>
            <div className="s">{chain.ok ? "live" : "connecting…"}</div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap grid-2" style={{ alignItems: "center", gap: 48 }}>
          <div>
            <div className="section-h">
              <span className="eyebrow">How it works</span>
              <h2>From 402 to 200 in one payment</h2>
              <p>The seller's server answers with a price. The buyer checks that price against the contract, pays once, and proves it with a signature. Access lasts for the window the seller set.</p>
            </div>
            <div className="steps4" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
              <div>
                <span className="n">01</span>
                <h3>Quote</h3>
                <p>An unpaid request gets HTTP 402 with the chain, contract, resource and price.</p>
              </div>
              <div>
                <span className="n">02</span>
                <h3>Verify</h3>
                <p>The buyer re-reads the quote on-chain and refuses if the server's numbers differ.</p>
              </div>
              <div>
                <span className="n">03</span>
                <h3>Pay</h3>
                <p>
                  <span className="mono">pay(id, minWindow)</span> with value equal to the price. Reverts if the seller changed the deal.
                </p>
              </div>
              <div>
                <span className="n">04</span>
                <h3>Prove</h3>
                <p>A signature bound to chain, contract, resource and host shows the server who paid.</p>
              </div>
            </div>
          </div>
          <Exchange />
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="section-h">
            <span className="eyebrow">Why Arc</span>
            <h2>Paying for an API should be one step</h2>
            <p>On most EVM chains an agent needs two assets and two transactions before it can buy anything. On Arc it needs one of each.</p>
          </div>
          <div className="card tablewrap">
            <table className="compare">
              <thead>
                <tr>
                  <th />
                  <th>Typical EVM chain</th>
                  <th>Arc with PayGate</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Assets the buyer must hold</td>
                  <td>A stablecoin, plus ETH for gas</td>
                  <td className="arc">USDC only</td>
                </tr>
                <tr>
                  <td>Transactions per first purchase</td>
                  <td>approve, then transfer</td>
                  <td className="arc">One pay() call</td>
                </tr>
                <tr>
                  <td>Gas paid in</td>
                  <td>A volatile token</td>
                  <td className="arc">USDC, a fraction of a cent per pass</td>
                </tr>
                <tr>
                  <td>Who holds the money</td>
                  <td>Often a facilitator or custodian</td>
                  <td className="arc">The contract, until the seller withdraws</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap grid-2" style={{ gap: 48, alignItems: "start" }}>
          <div className="section-h" style={{ marginBottom: 0 }}>
            <span className="eyebrow">For agents</span>
            <h2>Buy access from a script</h2>
            <p>The reference client treats the 402 body as untrusted: it pins the contract, re-reads the terms on-chain, builds the transaction itself and caps what it will spend.</p>
            <div className="row" style={{ marginTop: 12 }}>
              <a className="btn btn-secondary" href="#/agents">
                Integration guide <Arrow />
              </a>
            </div>
          </div>
          <CodeTabs
            tabs={[
              {
                key: "py",
                label: "Python",
                plain: `pip install web3 eth-account httpx\nexport EVM_PRIVATE_KEY=0x…\npython py/client.py fetch \\\n  https://api.example.com/api/data \\\n  --contract ${net.contract ?? "0x…"} \\\n  --max-usdc 0.05`,
                rich: (
                  <>
                    <span className="c">{"# pip install web3 eth-account httpx\n"}</span>
                    <span className="k">export</span>
                    {" EVM_PRIVATE_KEY=0x…\n"}
                    {"python py/client.py "}
                    <span className="k">fetch</span>
                    {" \\\n  https://api.example.com/api/data \\\n  --contract "}
                    <span className="s">{net.contract ?? "0x…"}</span>
                    {" \\\n  --max-usdc "}
                    <span className="w">0.05</span>
                  </>
                ),
              },
              {
                key: "sol",
                label: "Contract",
                plain: `function quote(uint256 id) view returns (uint96 price, uint32 window, address seller, bool active, string uri);\nfunction pay(uint256 id, uint32 minWindow) payable returns (uint64 until);\nfunction hasAccess(address who, uint256 id) view returns (bool);`,
              },
            ]}
          />
        </div>
      </section>
    </>
  );
}
