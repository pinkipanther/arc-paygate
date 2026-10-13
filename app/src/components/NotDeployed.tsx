import { Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NETWORKS, NET_KEYS } from "../config";
import { useApp } from "../lib/store";

/** Shown wherever contract data would appear on a network without a deployment. */
export function NotDeployed() {
  const { net, setNet } = useApp();
  const nets = NET_KEYS.map((k) => NETWORKS[k]).filter((n) => n.key !== net.key && n.contract);
  const other = nets.find((n) => !n.simulated) ?? nets.find((n) => n.simulated);
  return (
    <div className="flex flex-col items-start gap-4 rounded-2xl border border-primary/20 bg-primary/[0.04] p-5 sm:flex-row sm:items-center">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
        <Rocket className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">Not on {net.label} yet</div>
        <div className="text-sm text-muted-foreground">{other && !other.simulated ? `Live on ${other.label}.` : "Deployment pending. The demo runs the same contract in your browser."}</div>
      </div>
      {other && (
        <Button onClick={() => setNet(other.key)} className="rounded-full">
          {other.simulated ? "Open the demo" : `Switch to ${other.short}`}
        </Button>
      )}
    </div>
  );
}
