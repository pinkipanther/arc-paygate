import { useEffect, useRef, useState } from "react";
import { NETWORKS, NET_KEYS } from "../config";
import { short, usdc } from "../lib/format";
import { useChainInfo, useWalletBalance } from "../lib/hooks";
import { useApp } from "../lib/store";
import { Chevron, Logo, Wallet } from "./icons";

export const NAV: [string, string][] = [
  ["#/", "Overview"],
  ["#/market", "Marketplace"],
  ["#/sell", "Sell"],
  ["#/activity", "Activity"],
  ["#/agents", "For agents"],
];

function isCurrent(href: string, route: string) {
  const r = route || "#/";
  if (href === "#/") return r === "#/" || r === "#" || r === "";
  return r.startsWith(href) || (href === "#/market" && r.startsWith("#/r/"));
}

function NetworkSwitch() {
  const { netKey, net, setNet } = useApp();
  const info = useChainInfo();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);
  const tone = !info.ok ? (info.block === null ? "" : "bad") : net.contract ? "ok" : "warn";
  return (
    <div className="netswitch" ref={ref}>
      <button className="netbtn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={info.block ? `Block ${info.block.toLocaleString()}` : "Connecting"}>
        <span className={`dot ${tone}`} />
        <span>{net.short}</span>
        <Chevron width={14} height={14} />
      </button>
      {open && (
        <div className="netmenu" role="menu">
          {NET_KEYS.map((k) => {
            const n = NETWORKS[k];
            return (
              <button
                key={k}
                role="menuitemradio"
                aria-checked={k === netKey}
                onClick={() => {
                  setNet(k);
                  setOpen(false);
                }}
              >
                <span className={`dot ${n.contract ? "ok" : ""}`} />
                <span>
                  <div style={{ fontWeight: 600 }}>{n.label}</div>
                  <small>chain {n.chain.id}</small>
                </span>
                <small>{n.contract ? "live" : "not deployed"}</small>
              </button>
            );
          })}
          <div style={{ padding: "8px 10px 4px", fontSize: "0.78rem", color: "var(--muted)", borderTop: "1px solid var(--line)", marginTop: 4 }}>
            {info.block ? (
              <>
                Block <span className="mono">{info.block.toLocaleString()}</span>
                {info.gasPrice ? (
                  <>
                    {" · "}gas <span className="mono">{(Number(info.gasPrice) / 1e9).toFixed(1)} gwei</span>
                  </>
                ) : null}
              </>
            ) : (
              "Connecting to RPC…"
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function WalletButton() {
  const { wallet, openWallet, disconnect } = useApp();
  const bal = useWalletBalance(wallet?.address);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);
  if (!wallet)
    return (
      <button className="btn btn-primary btn-sm" onClick={() => openWallet(true)} style={{ height: 36 }}>
        <Wallet />
        Connect
      </button>
    );
  return (
    <div className="netswitch" ref={ref}>
      <button className="netbtn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        {wallet.icon ? <img src={wallet.icon} alt="" width={16} height={16} style={{ borderRadius: 4 }} /> : <Wallet />}
        <span className="mono" style={{ fontSize: "0.84rem" }}>
          {short(wallet.address, 5, 4)}
        </span>
        {bal !== null && (
          <span className="muted mono" style={{ fontSize: "0.8rem" }}>
            {usdc(bal, 2)}
          </span>
        )}
      </button>
      {open && (
        <div className="netmenu" role="menu" style={{ minWidth: 260 }}>
          <div style={{ padding: "8px 10px 10px" }}>
            <div className="eyebrow">{wallet.name}</div>
            <div className="mono" style={{ fontSize: "0.82rem", marginTop: 4, overflowWrap: "anywhere" }}>
              {wallet.address}
            </div>
            <div style={{ marginTop: 8, fontSize: "0.9rem" }}>
              <span className="mono">{bal === null ? "…" : usdc(bal)}</span> <span className="muted">USDC</span>
            </div>
          </div>
          <button
            role="menuitem"
            onClick={() => {
              disconnect();
              setOpen(false);
            }}
            style={{ gridTemplateColumns: "1fr" }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

export function Header({ route }: { route: string }) {
  return (
    <header className="topbar">
      <div className="wrap">
        <div className="topbar-in">
          <a href="#/" className="brand" aria-label="PayGate home">
            <span className="brand-mark">
              <Logo />
            </span>
            PayGate
          </a>
          <nav className="nav" aria-label="Main">
            {NAV.map(([href, label]) => (
              <a key={href} href={href} aria-current={isCurrent(href, route) ? "page" : undefined}>
                {label}
              </a>
            ))}
          </nav>
          <div className="top-actions">
            <NetworkSwitch />
            <WalletButton />
          </div>
        </div>
        <nav className="subnav" aria-label="Main (compact)">
          {NAV.map(([href, label]) => (
            <a key={href} href={href} aria-current={isCurrent(href, route) ? "page" : undefined}>
              {label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}
