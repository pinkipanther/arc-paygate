import { NETWORKS, NET_KEYS } from "../config";
import { useApp } from "../lib/store";

/** Shown wherever contract data would appear on a network without a deployment. */
export function NotDeployed({ compact }: { compact?: boolean }) {
  const { net, setNet } = useApp();
  const nets = NET_KEYS.map((k) => NETWORKS[k]).filter((n) => n.key !== net.key && n.contract);
  const other = nets.find((n) => !n.simulated) ?? nets.find((n) => n.simulated);
  return (
    <div className="banner info" style={compact ? { fontSize: "0.86rem" } : undefined}>
      <span>
        <b>PayGate isn't deployed on {net.label} yet.</b>{" "}
        {other && !other.simulated
          ? `It is live on ${other.label}.`
          : "The deployment is pending. Meanwhile the Demo network runs the same audited contract in your browser, with a funded wallet, so you can try every step."}
      </span>
      {other && (
        <button className="btn btn-secondary btn-sm" onClick={() => setNet(other.key)}>
          {other.simulated ? "Open the demo" : `Switch to ${other.short}`}
        </button>
      )}
    </div>
  );
}
