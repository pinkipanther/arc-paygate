import { useMemo, useState } from "react";
import { formatUnits, getAddress } from "viem";
import { MAX_URI } from "../config";
import { Pass } from "../components/Pass";
import { NotDeployed } from "../components/NotDeployed";
import { Box, Plus, Wallet } from "../components/icons";
import { Empty, Modal, Spinner } from "../components/ui";
import { duration, intFmt, isAddress, parseUsdc, sameAddr, usdc } from "../lib/format";
import { useBalance, useResources, type Resource } from "../lib/hooks";
import { buildMeta, byteLength, parseMeta } from "../lib/meta";
import { useApp } from "../lib/store";
import { useTx } from "../lib/tx";

const MAX_WINDOW = 365 * 86400;
const WINDOWS: [number, string][] = [
  [900, "15 min"],
  [3600, "1 hour"],
  [86400, "1 day"],
  [604800, "7 days"],
  [2592000, "30 days"],
];
const PRICES = ["0.01", "0.05", "0.10", "1.00"];

interface Draft {
  name: string;
  desc: string;
  url: string;
  price: string;
  window: number;
  customMin: string;
}

const blank: Draft = { name: "", desc: "", url: "", price: "0.01", window: 3600, customMin: "" };

function validate(d: Draft) {
  const price = parseUsdc(d.price);
  const window = d.window === -1 ? Math.round(Number(d.customMin) * 60) : d.window;
  const uri = buildMeta({ name: d.name, desc: d.desc, url: d.url });
  const bytes = byteLength(uri);
  const errs: Partial<Record<"name" | "url" | "price" | "window" | "uri", string>> = {};
  if (!d.name.trim()) errs.name = "Give buyers a name to recognise.";
  if (d.url.trim() && !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(d.url.trim())) errs.url = "Use a full URL starting with https://";
  if (price === null) errs.price = "Enter a price in USDC, for example 0.05.";
  else if (/\.\d{7,}/.test(d.price.trim())) errs.price = "Use at most 6 decimal places; USDC's smallest unit is 0.000001.";
  else if (price >= 2n ** 96n) errs.price = "That price is too large.";
  if (!Number.isFinite(window) || window < 1) errs.window = "Pick an access window.";
  else if (window > MAX_WINDOW) errs.window = "The longest window is 365 days.";
  if (bytes > MAX_URI) errs.uri = `Listing details are ${bytes} bytes; the limit is ${MAX_URI}. Shorten the description.`;
  return { price, window, uri, bytes, errs, ok: Object.keys(errs).length === 0 };
}

function TermsFields({ d, set, v }: { d: Draft; set: (p: Partial<Draft>) => void; v: ReturnType<typeof validate> }) {
  const perHour = v.price !== null && v.window > 0 ? (v.price * 3600n) / BigInt(v.window) : null;
  return (
    <>
      <div className="field">
        <label htmlFor="f-name">Name</label>
        <input id="f-name" className="input" placeholder="Polymarket reward pools" value={d.name} onChange={(e) => set({ name: e.target.value })} aria-invalid={!!v.errs.name && d.name !== ""} maxLength={80} />
      </div>
      <div className="field">
        <label htmlFor="f-desc">Description</label>
        <textarea id="f-desc" className="textarea" placeholder="What the buyer gets, how fresh it is, response format." value={d.desc} onChange={(e) => set({ desc: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="f-url">Endpoint URL</label>
        <input id="f-url" className="input mono" placeholder="https://api.yourhost.com/v1/data" value={d.url} onChange={(e) => set({ url: e.target.value })} aria-invalid={!!v.errs.url} spellCheck={false} />
        {v.errs.url ? <span className="err">{v.errs.url}</span> : <span className="hint">The URL your PayGate server answers on. Buyers sign requests for this host.</span>}
      </div>
      <div className="grid-2" style={{ gap: 16 }}>
        <div className="field">
          <label htmlFor="f-price">Price</label>
          <div className="input-affix">
            <input id="f-price" className="input mono" inputMode="decimal" value={d.price} onChange={(e) => set({ price: e.target.value })} aria-invalid={!!v.errs.price} />
            <span>USDC</span>
          </div>
          <div className="chips">
            {PRICES.map((p) => (
              <button type="button" key={p} className="chip" aria-pressed={d.price === p} onClick={() => set({ price: p })}>
                {p}
              </button>
            ))}
          </div>
          {v.errs.price && <span className="err">{v.errs.price}</span>}
        </div>
        <div className="field">
          <label>Access window</label>
          <div className="chips">
            {WINDOWS.map(([s, l]) => (
              <button type="button" key={s} className="chip" aria-pressed={d.window === s} onClick={() => set({ window: s })}>
                {l}
              </button>
            ))}
            <button type="button" className="chip" aria-pressed={d.window === -1} onClick={() => set({ window: -1 })}>
              Custom
            </button>
          </div>
          {d.window === -1 && (
            <div className="input-affix">
              <input className="input mono" inputMode="numeric" placeholder="90" value={d.customMin} onChange={(e) => set({ customMin: e.target.value })} aria-label="Custom window in minutes" />
              <span>minutes</span>
            </div>
          )}
          {v.errs.window && <span className="err">{v.errs.window}</span>}
        </div>
      </div>
      <div className="spread" style={{ fontSize: "0.84rem" }}>
        <span className="muted">{perHour !== null ? <>Effective rate <span className="mono ink2">{usdc(perHour)} USDC / hour</span></> : " "}</span>
        <span className="mono" style={{ color: v.errs.uri ? "var(--bad)" : "var(--muted)" }}>
          {v.bytes}/{MAX_URI} bytes on-chain
        </span>
      </div>
      {v.errs.uri && <span className="err" style={{ fontSize: "0.82rem", color: "var(--bad)" }}>{v.errs.uri}</span>}
    </>
  );
}

function CreateForm() {
  const { wallet, openWallet, net } = useApp();
  const tx = useTx();
  const [d, setD] = useState<Draft>(blank);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const v = validate(d);
  const preview: Resource = useMemo(
    () => ({
      id: 0n,
      seller: wallet?.address ?? "0x0000000000000000000000000000000000000000",
      price: v.price ?? 0n,
      window: v.window > 0 ? v.window : 3600,
      active: true,
      sales: 0n,
      revenue: 0n,
      uri: v.uri,
      meta: { ...parseMeta(v.uri, 0), name: d.name.trim() || "Your resource" },
    }),
    [wallet?.address, v.price, v.window, v.uri, d.name],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet) return openWallet(true);
    if (!v.ok || v.price === null) return;
    setBusy(true);
    try {
      await tx({ label: `List “${d.name.trim()}”`, functionName: "createResource", args: [v.price, v.window, v.uri], success: () => "Listed. It's in the marketplace now." });
      setD(blank);
    } catch {
      /* toast already explains */
    } finally {
      setBusy(false);
    }
  }

  const example402 = JSON.stringify(
    { scheme: "paygate-native-v2", chain_id: net.chain.id, contract: net.contract ?? "0x…", resource_id: "<assigned on listing>", price_usdc: usdc(v.price ?? 0n), window_seconds: v.window > 0 ? v.window : 0 },
    null,
    2,
  );

  return (
    <div className="grid-create">
      <form className="card" onSubmit={submit} noValidate>
        <div className="card-h">
          <h3>List a resource</h3>
          <span className="muted" style={{ fontSize: "0.84rem" }}>One transaction</span>
        </div>
        <div className="card-b stack" style={{ gap: 18 }}>
          <TermsFields d={d} set={set} v={v} />
        </div>
        <div className="card-f spread">
          <span className="muted" style={{ fontSize: "0.84rem" }}>
            You can reprice, pause or hand it to another address later.
          </span>
          <button className="btn btn-primary" type="submit" disabled={!net.contract || busy || (!!wallet && !v.ok)}>
            {busy && <Spinner />}
            {!net.contract ? "Not deployed on this network" : wallet ? "List resource" : "Connect wallet to list"}
          </button>
        </div>
      </form>
      <div className="stack sticky-col" style={{ gap: 16 }}>
        <span className="eyebrow">What buyers see</span>
        <Pass r={preview} until={0} preview />
        <div>
          <div className="label" style={{ marginBottom: 6 }}>
            The 402 your server returns
          </div>
          <pre className="code" style={{ fontSize: "0.78rem" }}>
            {example402}
          </pre>
        </div>
      </div>
    </div>
  );
}

function EditModal({ r, onClose }: { r: Resource; onClose: () => void }) {
  const tx = useTx();
  const [d, setD] = useState<Draft>(() => {
    const w = WINDOWS.some(([s]) => s === r.window) ? r.window : -1;
    return { name: r.meta.name, desc: r.meta.desc, url: r.meta.url ?? "", price: formatUnits(r.price, 18), window: w, customMin: w === -1 ? String(r.window / 60) : "" };
  });
  const [active, setActive] = useState(r.active);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const v = validate(d);
  async function save() {
    if (!v.ok || v.price === null) return;
    setBusy(true);
    try {
      await tx({ label: `Update #${r.id}`, functionName: "updateResource", args: [r.id, v.price, v.window, active, v.uri], success: () => "Listing updated." });
      onClose();
    } catch {
      /* toast explains */
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Edit #${r.id} · ${r.meta.name}`} onClose={onClose} wide>
      <div className="stack" style={{ gap: 18 }}>
        <TermsFields d={d} set={set} v={v} />
        <label className="switch">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          {active ? "On sale" : "Paused (existing passes keep working)"}
        </label>
        <div className="banner info" style={{ fontSize: "0.84rem" }}>
          Changing the price or shortening the window makes in-flight purchases revert, so buyers never pay more or get less than they were quoted.
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !v.ok}>
            {busy && <Spinner />}Save changes
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TransferModal({ r, onClose }: { r: Resource; onClose: () => void }) {
  const tx = useTx();
  const [to, setTo] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const ok = isAddress(to) && !sameAddr(to, r.seller);
  async function go() {
    setBusy(true);
    try {
      await tx({ label: `Transfer #${r.id}`, functionName: "transferResource", args: [r.id, getAddress(to)], success: () => "Transferred. Future sales go to the new seller." });
      onClose();
    } catch {
      /* toast */
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Transfer #${r.id}`} onClose={onClose}>
      <div className="stack" style={{ gap: 16 }}>
        <p className="ink2">The new address receives all future sales and controls the listing. USDC you've already earned stays withdrawable by you.</p>
        <div className="field">
          <label htmlFor="t-to">New seller address</label>
          <input id="t-to" className="input mono" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={to !== "" && !ok} spellCheck={false} />
        </div>
        <label className="row" style={{ fontSize: "0.88rem" }}>
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I control this address or trust its owner. This can't be undone by me.
        </label>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={go} disabled={!ok || !confirm || busy}>
            {busy && <Spinner />}Transfer listing
          </button>
        </div>
      </div>
    </Modal>
  );
}

function WithdrawToModal({ amount, onClose }: { amount: bigint; onClose: () => void }) {
  const tx = useTx();
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await tx({ label: `Withdraw ${usdc(amount)} USDC`, functionName: "withdrawTo", args: [getAddress(to)], success: () => `Sent to ${to.slice(0, 8)}…` });
      onClose();
    } catch {
      /* toast */
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Withdraw to another address" onClose={onClose}>
      <div className="stack" style={{ gap: 16 }}>
        <p className="ink2">
          Sends your full balance of <span className="mono">{usdc(amount)} USDC</span> to a cold wallet or exchange deposit address. Useful when your seller address can't receive USDC itself.
        </p>
        <div className="field">
          <label htmlFor="w-to">Destination</label>
          <input id="w-to" className="input mono" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={to !== "" && !isAddress(to)} spellCheck={false} />
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={go} disabled={!isAddress(to) || busy}>
            {busy && <Spinner />}Withdraw
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function Sell() {
  const { net, wallet, openWallet } = useApp();
  const res = useResources();
  const bal = useBalance(wallet?.address);
  const tx = useTx();
  const [edit, setEdit] = useState<Resource | null>(null);
  const [xfer, setXfer] = useState<Resource | null>(null);
  const [wTo, setWTo] = useState(false);
  const [busyW, setBusyW] = useState(false);
  const [toggling, setToggling] = useState<bigint | null>(null);
  const mine = (res.data ?? []).filter((r) => sameAddr(r.seller, wallet?.address));
  const lifetime = mine.reduce((a, r) => a + r.revenue, 0n);
  const sold = mine.reduce((a, r) => a + r.sales, 0n);

  async function withdraw() {
    setBusyW(true);
    try {
      await tx({ label: `Withdraw ${usdc(bal ?? 0n)} USDC`, functionName: "withdraw", args: [], success: () => "Sent to your wallet." });
    } catch {
      /* toast */
    } finally {
      setBusyW(false);
    }
  }

  async function toggle(r: Resource) {
    setToggling(r.id);
    try {
      await tx({ label: r.active ? `Pause #${r.id}` : `Resume #${r.id}`, functionName: "updateResource", args: [r.id, r.price, r.window, !r.active, r.uri], success: () => (r.active ? "Paused. Existing passes keep working." : "Back on sale.") });
    } catch {
      /* toast */
    } finally {
      setToggling(null);
    }
  }

  return (
    <div className="wrap">
      <div className="page-h">
        <div>
          <h1>Sell access</h1>
          <p>List an endpoint, set a price per window, and collect USDC as passes sell. Your server checks one view call before answering.</p>
        </div>
      </div>

      {!net.contract ? (
        <div className="stack" style={{ gap: 28 }}>
          <NotDeployed />
          <CreateForm />
        </div>
      ) : (
        <div className="stack" style={{ gap: 28 }}>
          <div className="card">
            <div className="split">
              <div className="card-b">
                <span className="eyebrow">Ready to withdraw</span>
                <div className="price-big" style={{ marginTop: 8 }}>
                  <span className="amt num">{wallet ? (bal === null ? "…" : usdc(bal)) : "—"}</span>
                  <span className="unit">USDC</span>
                </div>
                <div className="row" style={{ marginTop: 16 }}>
                  {wallet ? (
                    <>
                      <button className="btn btn-primary" onClick={withdraw} disabled={!bal || busyW}>
                        {busyW && <Spinner />}Withdraw to my wallet
                      </button>
                      <button className="btn btn-secondary" onClick={() => setWTo(true)} disabled={!bal}>
                        Withdraw elsewhere
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-primary" onClick={() => openWallet(true)}>
                      <Wallet /> Connect wallet
                    </button>
                  )}
                </div>
              </div>
              <div className="card-b">
                <dl className="kv">
                  <dt>Your listings</dt>
                  <dd className="num">{wallet ? intFmt(mine.length) : "—"}</dd>
                  <dt>Passes sold</dt>
                  <dd className="num">{wallet ? intFmt(sold) : "—"}</dd>
                  <dt>Lifetime revenue</dt>
                  <dd className="mono">{wallet ? `${usdc(lifetime)} USDC` : "—"}</dd>
                  <dt>Fees</dt>
                  <dd>None. The contract has no owner and takes no cut.</dd>
                </dl>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>Your listings</h3>
              <button className="btn btn-secondary btn-sm" onClick={() => document.getElementById("new")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                <Plus /> New
              </button>
            </div>
            {!wallet ? (
              <Empty icon={<Wallet />} title="Connect to see your listings" action={<button className="btn btn-primary" onClick={() => openWallet(true)}>Connect wallet</button>}>
                Listings belong to the address that created them.
              </Empty>
            ) : mine.length === 0 ? (
              <Empty icon={<Box />} title="No listings yet">
                Fill in the form below. Your first listing takes one transaction and shows up in the marketplace right away.
              </Empty>
            ) : (
              <div className="tablewrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Resource</th>
                      <th className="r">Price</th>
                      <th>Window</th>
                      <th className="r">Sold</th>
                      <th className="r">Revenue</th>
                      <th>On sale</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {mine.map((r) => (
                      <tr key={r.id.toString()}>
                        <td>
                          <a href={`#/r/${r.id}`} style={{ fontWeight: 600, color: "var(--ink)" }}>
                            {r.meta.name}
                          </a>
                          <div className="muted mono" style={{ fontSize: "0.78rem" }}>
                            #{r.id.toString()} {r.meta.host ? `· ${r.meta.host}` : ""}
                          </div>
                        </td>
                        <td className="r mono">{usdc(r.price)}</td>
                        <td>{duration(r.window)}</td>
                        <td className="r num">{intFmt(r.sales)}</td>
                        <td className="r mono">{usdc(r.revenue)}</td>
                        <td>
                          <label className="switch" title={r.active ? "Pause new sales" : "Resume sales"}>
                            <input type="checkbox" checked={r.active} disabled={toggling === r.id} onChange={() => toggle(r)} aria-label={r.active ? "Pause" : "Resume"} />
                          </label>
                        </td>
                        <td className="r">
                          <div className="row" style={{ justifyContent: "flex-end", gap: 6, flexWrap: "nowrap" }}>
                            <button className="btn btn-secondary btn-sm" onClick={() => setEdit(r)}>
                              Edit
                            </button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setXfer(r)}>
                              Transfer
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div id="new">
            <CreateForm />
          </div>
        </div>
      )}
      {edit && <EditModal r={edit} onClose={() => setEdit(null)} />}
      {xfer && <TransferModal r={xfer} onClose={() => setXfer(null)} />}
      {wTo && bal !== null && <WithdrawToModal amount={bal} onClose={() => setWTo(false)} />}
    </div>
  );
}
