import { useState } from "react";
import { getAddress, type Address } from "viem";
import { duration, isAddress, usdc } from "../lib/format";
import { useWalletBalance, type Resource } from "../lib/hooks";
import { useApp } from "../lib/store";
import { useTx, type Stage } from "../lib/tx";
import { Spinner } from "./ui";

const PAY_GAS = 80_000n;
const STEPS: [Stage, string][] = [
  ["check", "Check the terms on-chain"],
  ["sign", "Approve in your wallet"],
  ["settle", "Settle on Arc"],
  ["done", "Pass issued"],
];

export function BuyPanel({ r, held, onBought }: { r: Resource; held: boolean; onBought?: () => void }) {
  const { wallet, openWallet, net } = useApp();
  const tx = useTx();
  const bal = useWalletBalance(wallet?.address);
  const [forOther, setForOther] = useState(false);
  const [other, setOther] = useState("");
  const [stage, setStage] = useState<Stage | null>(null);
  const [busy, setBusy] = useState(false);

  const otherOk = !forOther || isAddress(other);
  const free = r.price === 0n;
  const need = r.price + PAY_GAS * 20_000_000_000n; // price + gas at the 20 gwei floor
  const short = bal !== null && bal < need;
  const idx = stage ? STEPS.findIndex(([s]) => s === stage) : -1;

  async function buy() {
    if (!wallet) return openWallet(true);
    setBusy(true);
    try {
      const minWindow = r.window;
      if (forOther) {
        await tx(
          { label: `Buy a pass for ${getAddress(other).slice(0, 8)}…`, functionName: "payFor", args: [r.id, getAddress(other) as Address, minWindow], value: r.price, success: () => "The pass is in their wallet's name now." },
          setStage,
        );
      } else {
        await tx(
          { label: held ? "Extend your pass" : `Buy ${r.meta.name}`, functionName: "pay", args: [r.id, minWindow], value: r.price, success: () => (held && !free ? "Your pass now runs longer." : "Your pass is active.") },
          setStage,
        );
      }
      onBought?.();
      setTimeout(() => setStage(null), 2500);
    } catch {
      setStage(null);
    } finally {
      setBusy(false);
    }
  }

  const label = !wallet
    ? "Connect wallet to buy"
    : !r.active
      ? "Not on sale"
      : free
        ? forOther
          ? "Claim a free pass for them"
          : held
            ? "Renew free pass"
            : "Claim free pass"
        : forOther
          ? `Pay ${usdc(r.price)} USDC for them`
          : held
            ? `Extend for ${usdc(r.price)} USDC`
            : `Pay ${usdc(r.price)} USDC`;

  return (
    <div className="card">
      <div className="card-b stack" style={{ gap: 18 }}>
        <div>
          <div className="eyebrow">{held ? "Extend your pass" : "Buy a pass"}</div>
          <div className="price-big" style={{ marginTop: 6 }}>
            <span className="amt num">{usdc(r.price)}</span>
            <span className="unit">USDC</span>
            <span className="per">for {duration(r.window)}</span>
          </div>
          {held && (
            <p className="muted" style={{ fontSize: "0.86rem", marginTop: 4 }}>
              {free ? `Free passes don't stack: claiming again resets your pass to ${duration(r.window)} from now.` : `Paying again adds ${duration(r.window)} on top of the time you have left.`}
            </p>
          )}
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <span className="label">Pass holder</span>
          <div className="seg" role="radiogroup" aria-label="Pass holder">
            <button aria-pressed={!forOther} onClick={() => setForOther(false)}>
              My wallet
            </button>
            <button aria-pressed={forOther} onClick={() => setForOther(true)}>
              Another address
            </button>
          </div>
          {forOther && (
            <div className="field">
              <input
                className="input mono"
                placeholder="0x… agent or teammate address"
                value={other}
                onChange={(e) => setOther(e.target.value)}
                aria-invalid={other !== "" && !isAddress(other)}
                spellCheck={false}
                autoComplete="off"
              />
              <span className="hint">Useful for funding an agent's key from your main wallet. They hold the pass; you pay.</span>
            </div>
          )}
        </div>

        <button className="btn btn-primary btn-lg btn-block" disabled={busy || (!!wallet && (!r.active || !otherOk))} onClick={buy}>
          {busy && <Spinner />}
          {label}
        </button>

        {stage && (
          <ol className="stepper" aria-label="Payment progress">
            {STEPS.map(([s, text], i) => (
              <li key={s} className={i < idx || stage === "done" ? "done" : i === idx ? "now" : ""}>
                <span className="i">{i < idx || stage === "done" ? "✓" : i + 1}</span>
                <span>{text}</span>
              </li>
            ))}
          </ol>
        )}

        {wallet && bal !== null && (
          <div className="spread" style={{ fontSize: "0.86rem" }}>
            <span className="muted">Wallet balance</span>
            <span className={`mono ${short ? "" : ""}`} style={{ color: short ? "var(--bad)" : undefined }}>
              {usdc(bal)} USDC
            </span>
          </div>
        )}
        {wallet && short && (
          <div className="banner" style={{ fontSize: "0.85rem" }}>
            <span>
              You need about <b className="mono">{usdc(need)} USDC</b> for the price plus gas.{" "}
              {net.faucet && (
                <a href={net.faucet} target="_blank" rel="noopener noreferrer">
                  Get test USDC from Circle's faucet.
                </a>
              )}
            </span>
          </div>
        )}
      </div>
      <div className="card-f" style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
        One <span className="mono">pay()</span> call, gas included in USDC. The contract reverts if the seller changed the price or shortened the window after you loaded this page. No refunds: delivery is the seller's server.
      </div>
    </div>
  );
}
