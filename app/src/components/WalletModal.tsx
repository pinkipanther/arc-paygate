import { ChevronRight, Puzzle, TerminalSquare } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NETWORKS } from "../config";
import { useApp } from "../lib/store";
import { Spinner } from "./common";

function Option({ icon, title, sub, onClick, disabled, busy }: { icon: React.ReactNode; title: string; sub: string; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-xl border bg-card p-3 text-left transition-all hover:border-primary/40 hover:bg-accent/40 disabled:opacity-60"
    >
      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border bg-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{sub}</span>
      </span>
      {busy ? <Spinner /> : <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />}
    </button>
  );
}

export function WalletModal() {
  const { walletOpen, openWallet, wallets, connect, connecting, netKey, setNet } = useApp();
  const devAvailable = import.meta.env.DEV && netKey === "local" && !!NETWORKS.local.contract;
  return (
    <Dialog open={walletOpen} onOpenChange={openWallet}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect a wallet</DialogTitle>
          <DialogDescription>One balance pays for passes and gas. PayGate never sees your keys.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {wallets.map((w) => (
            <Option
              key={w.info.rdns}
              icon={w.info.icon ? <img src={w.info.icon} alt="" className="size-6" /> : <span className="font-semibold">{w.info.name.slice(0, 1)}</span>}
              title={w.info.name}
              sub="Browser extension"
              onClick={() => connect(w)}
              disabled={connecting}
              busy={connecting}
            />
          ))}
          {devAvailable && <Option icon={<TerminalSquare className="size-5" />} title="Anvil dev account" sub="Local chain only" onClick={() => connect("dev")} disabled={connecting} />}
          {wallets.length === 0 && !devAvailable && (
            <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
              <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
                <Puzzle className="size-4" /> No browser wallet found
              </div>
              Install MetaMask or Rabby and reload, or{" "}
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onClick={() => {
                  setNet("demo");
                  openWallet(false);
                }}
              >
                try the demo
              </button>{" "}
              with a funded throwaway wallet.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
