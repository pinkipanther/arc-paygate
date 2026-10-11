import { NETWORKS, NET_KEYS } from "../config";
import { useApp } from "../lib/store";

/** Shown wherever contract data would appear on a network without a deployment. */
export function NotDeployed({ compact }: { compact?: boolean }) {
  const { net, setNet } = useApp();
  const other = NET_KEYS.map((k) => NETWORKS[k]).find((n) => n.key !== net.key && n.contract);
  return (
    <div className="banner info" style={compact ? { fontSize: "0.86rem" } : undefined}>
      <span>
        <b>PayGate isn't deployed on {net.label} yet.</b>{" "}
        {other ? `It is live on ${other.label}.` : "The contract, tests and audit are in the repository; the deployment is pending."}
      </span>
      {other && (
        <button className="btn btn-secondary btn-sm" onClick={() => setNet(other.key)}>
          Switch to {other.short}
        </button>
      )}
    </div>
  );
}
