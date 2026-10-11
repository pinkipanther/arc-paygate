import { NETWORKS } from "../config";
import { useApp } from "../lib/store";
import { Modal, Spinner } from "./ui";

export function WalletModal() {
  const { walletOpen, openWallet, wallets, connect, connecting, netKey } = useApp();
  if (!walletOpen) return null;
  const devAvailable = import.meta.env.DEV && netKey === "local" && !!NETWORKS.local.contract;
  return (
    <Modal title="Connect a wallet" onClose={() => openWallet(false)}>
      <div className="stack" style={{ gap: 10 }}>
        {wallets.length === 0 && !devAvailable && (
          <div className="banner info" style={{ display: "block" }}>
            <b>No browser wallet found.</b> Install MetaMask or Rabby, then reload this page. Any EVM wallet works; PayGate adds the Arc network for you.
          </div>
        )}
        {wallets.map((w) => (
          <button key={w.info.rdns} className="wallet-opt" disabled={connecting} onClick={() => connect(w)}>
            {w.info.icon ? <img src={w.info.icon} alt="" /> : <span className="ph">{w.info.name.slice(0, 1)}</span>}
            <span>
              <div style={{ fontWeight: 650 }}>{w.info.name}</div>
              <div className="muted" style={{ fontSize: "0.8rem" }}>
                Browser extension
              </div>
            </span>
            {connecting ? <Spinner /> : null}
          </button>
        ))}
        {devAvailable && (
          <button className="wallet-opt" disabled={connecting} onClick={() => connect("dev")}>
            <span className="ph">A</span>
            <span>
              <div style={{ fontWeight: 650 }}>Anvil dev account</div>
              <div className="muted" style={{ fontSize: "0.8rem" }}>
                Local chain only, signs in the page
              </div>
            </span>
          </button>
        )}
        <p className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>
          PayGate never sees your keys. Every payment is a single <span className="mono">pay()</span> call you approve in your wallet. On Arc, gas is paid in USDC, so one balance covers both.
        </p>
      </div>
    </Modal>
  );
}
