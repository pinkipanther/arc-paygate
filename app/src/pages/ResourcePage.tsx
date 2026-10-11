import { BuyPanel } from "../components/BuyPanel";
import { CodeTabs } from "../components/CodeTabs";
import { Arrow, Box } from "../components/icons";
import { NotDeployed } from "../components/NotDeployed";
import { Pass } from "../components/Pass";
import { UsePass } from "../components/UsePass";
import { Address, CopyButton, Empty, ExtLink, Skel, StatusPill } from "../components/ui";
import { duration, intFmt, sameAddr, usdc } from "../lib/format";
import { useAccess, useNow, useResource } from "../lib/hooks";
import { useApp } from "../lib/store";

export function ResourcePage({ id }: { id: bigint }) {
  const { net, wallet } = useApp();
  const res = useResource(id);
  const access = useAccess(id);
  const now = useNow();
  const r = res.data;
  const held = access.until > now;
  const mine = r && sameAddr(r.seller, wallet?.address);

  if (!net.contract)
    return (
      <div className="wrap">
        <NotDeployed />
      </div>
    );

  if (res.loading && !r)
    return (
      <div className="wrap stack" style={{ gap: 20 }}>
        <Skel w={120} h={14} />
        <Skel w="50%" h={34} />
        <div className="grid-main">
          <div className="skel" style={{ height: 210, borderRadius: 20 }} />
          <div className="skel" style={{ height: 320, borderRadius: 18 }} />
        </div>
      </div>
    );

  if (!r)
    return (
      <div className="wrap">
        <div className="card">
          <Empty icon={<Box />} title={`Resource #${id} doesn't exist on ${net.label}`} action={<a className="btn btn-secondary" href="#/market">Back to the marketplace</a>}>
            Ids are assigned in order as sellers list. This one hasn't been created yet, or you're on the wrong network.
          </Empty>
        </div>
      </div>
    );

  const perHour = r.window > 0 ? (r.price * 3600n) / BigInt(r.window) : 0n;
  const host = r.meta.host;
  const pyCmd = `python py/client.py fetch ${r.meta.url ?? "https://<seller-host>/<path>"} \\\n  --contract ${net.contract} --max-usdc ${usdc(r.price * 2n)}`;
  const solCheck = `// gate anything on-chain or off-chain with one view call\nbool ok = PayGate(${net.contract}).hasAccess(buyer, ${r.id});`;

  return (
    <div className="wrap">
      <a href="#/market" className="muted" style={{ fontSize: "0.88rem", display: "inline-flex", gap: 6, alignItems: "center" }}>
        <Arrow style={{ transform: "rotate(180deg)" }} width={14} height={14} /> Marketplace
      </a>

      <div className="page-h" style={{ marginTop: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="pill blue mono">#{r.id.toString()}</span>
            <StatusPill active={r.active} />
            {r.meta.kind && <span className="pill">{r.meta.kind}</span>}
            {mine && <span className="pill warn">You sell this</span>}
          </div>
          <h1 style={{ overflowWrap: "anywhere" }}>{r.meta.name}</h1>
          {r.meta.desc && <p>{r.meta.desc}</p>}
        </div>
        {mine && (
          <a className="btn btn-secondary" href="#/sell">
            Manage listing
          </a>
        )}
      </div>

      <div className="grid-main res-layout">
        <div className="stack res-left" style={{ gap: 20 }}>
          <div className="res-pass">
            <Pass r={r} until={access.until} holder={wallet?.address} />
          </div>

          <div className="card res-rest">
            <div className="card-h">
              <h3>Use your pass</h3>
              {held ? <span className="http s200">200</span> : <span className="http s402">402</span>}
            </div>
            <div className="card-b">
              <UsePass r={r} held={held} />
            </div>
          </div>

          <div className="card res-rest">
            <div className="card-h">
              <h3>Listing</h3>
            </div>
            <div className="card-b">
              <dl className="kv">
                <dt>Price</dt>
                <dd className="mono">{usdc(r.price)} USDC</dd>
                <dt>Access window</dt>
                <dd>{duration(r.window)}</dd>
                <dt>Effective rate</dt>
                <dd className="mono">{usdc(perHour)} USDC / hour</dd>
                <dt>Endpoint</dt>
                <dd>
                  {r.meta.url ? (
                    <span className="row" style={{ gap: 4 }}>
                      <span className="mono" style={{ fontSize: "0.86rem" }}>
                        {host}
                        {r.meta.path}
                      </span>
                      <CopyButton text={r.meta.url} label="Copy endpoint" />
                    </span>
                  ) : (
                    <span className="muted">Not listed</span>
                  )}
                </dd>
                <dt>Seller</dt>
                <dd>
                  <Address value={r.seller} />
                </dd>
                <dt>Passes sold</dt>
                <dd className="num">{intFmt(r.sales)}</dd>
                <dt>Revenue</dt>
                <dd className="mono">{usdc(r.revenue)} USDC</dd>
                <dt>Contract</dt>
                <dd>
                  <Address value={net.contract} />
                </dd>
              </dl>
              <p className="muted" style={{ fontSize: "0.82rem", marginTop: 16 }}>
                Sales and revenue are recorded by the contract. A seller can buy their own pass, so treat them as activity, not reputation.
              </p>
            </div>
          </div>

          <div className="card res-rest">
            <div className="card-h">
              <h3>Integrate</h3>
              {net.explorer && <ExtLink href={`${net.explorer}/address/${net.contract}`}>Contract on explorer</ExtLink>}
            </div>
            <div className="card-b">
              <CodeTabs
                tabs={[
                  { key: "py", label: "Agent (Python)", plain: pyCmd },
                  { key: "sol", label: "Solidity", plain: solCheck },
                  {
                    key: "raw",
                    label: "Raw call",
                    plain: `to:    ${net.contract}\ndata:  pay(${r.id}, ${r.window})\nvalue: ${r.price} wei  (${usdc(r.price)} USDC)\nchain: ${net.chain.id}`,
                  },
                ]}
              />
            </div>
          </div>
        </div>

        <div className="res-buy sticky-col">
          <BuyPanel r={r} held={held} onBought={access.reload} />
        </div>
      </div>
    </div>
  );
}
