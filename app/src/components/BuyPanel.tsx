import { useState } from "react";
import { getAddress, type Address } from "viem";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { duration, isAddress, usdc } from "../lib/format";
import { useWalletBalance, type Resource } from "../lib/hooks";
import { useApp } from "../lib/store";
import { useTx, type Stage } from "../lib/tx";
import { Eyebrow, Spinner } from "./common";

const PAY_GAS = 80_000n;
const STEPS: [Stage, string][] = [
  ["check", "Check terms"],
  ["sign", "Sign"],
  ["settle", "Settle"],
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
          { label: `Pass for ${getAddress(other).slice(0, 8)}…`, functionName: "payFor", args: [r.id, getAddress(other) as Address, minWindow], value: r.price, success: () => "The pass is in their name." },
          setStage,
        );
      } else {
        await tx(
          { label: held ? "Extend your pass" : `Buy ${r.meta.name}`, functionName: "pay", args: [r.id, minWindow], value: r.price, success: () => (held && !free ? "Your pass runs longer now." : "Your pass is active.") },
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
    ? "Connect wallet"
    : !r.active
      ? "Not on sale"
      : free
        ? forOther
          ? "Claim for them"
          : held
            ? "Renew free pass"
            : "Claim free pass"
        : forOther
          ? `Pay ${usdc(r.price)} USDC for them`
          : held
            ? `Extend · ${usdc(r.price)} USDC`
            : `Pay ${usdc(r.price)} USDC`;

  return (
    <div className="rounded-xl border bg-card p-6">
      <Eyebrow>{held ? "Extend your pass" : "Buy a pass"}</Eyebrow>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="font-mono text-4xl font-semibold tracking-tight tabular-nums">{usdc(r.price)}</span>
        <span className="text-sm text-muted-foreground">USDC / {duration(r.window)}</span>
      </div>
      {held && <p className="mt-2 text-xs text-muted-foreground">{free ? "Free passes reset, they don't stack." : `Adds ${duration(r.window)} to your time left.`}</p>}

      <Tabs value={forOther ? "other" : "me"} onValueChange={(v) => setForOther(v === "other")} className="mt-6">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="me">For me</TabsTrigger>
          <TabsTrigger value="other">For an agent</TabsTrigger>
        </TabsList>
      </Tabs>
      {forOther && (
          <div>
            <Input
              className="mt-3 font-mono text-xs"
              placeholder="0x… agent address"
              value={other}
              onChange={(e) => setOther(e.target.value)}
              aria-invalid={other !== "" && !isAddress(other)}
              aria-label="Pass holder address"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}

      <Button size="lg" className="mt-4 h-12 w-full rounded-xl text-base" disabled={busy || (!!wallet && (!r.active || !otherOk))} onClick={buy}>
        {busy && <Spinner />}
        {label}
      </Button>

      {stage && (
          <ol
            className="mt-4 grid grid-cols-4 gap-1.5"
            aria-label="Payment progress"
          >
            {STEPS.map(([s, text], i) => {
              const done = i < idx || stage === "done";
              const now = i === idx && stage !== "done";
              return (
                <li key={s} className="flex flex-col gap-1.5">
                  <span className={cn("h-1 rounded-full transition-colors duration-500", done ? "bg-success" : now ? "bg-primary" : "bg-muted")} />
                  <span className={cn("flex items-center gap-1 text-[11px]", done ? "text-success" : now ? "text-foreground" : "text-muted-foreground")}>
                    {done && <Check className="size-3" />}
                    {text}
                  </span>
                </li>
              );
            })}
          </ol>
        )}

      {wallet && bal !== null && (
        <div className="mt-5 flex items-center justify-between border-t pt-4 text-sm">
          <span className="text-muted-foreground">Balance</span>
          <span className={cn("font-mono", short && "text-destructive")}>{usdc(bal)} USDC</span>
        </div>
      )}
      {wallet && short && (
        <p className="mt-2 text-xs text-destructive">
          Need about {usdc(need)} USDC with gas.{" "}
          {net.faucet && (
            <a className="underline" href={net.faucet} target="_blank" rel="noopener noreferrer">
              Get test USDC
            </a>
          )}
        </p>
      )}
      <p className="mt-4 text-xs text-muted-foreground">One pay() call. Reverts if the terms change. No refunds.</p>
    </div>
  );
}
