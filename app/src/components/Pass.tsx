import { cn } from "@/lib/utils";
import { countdown, duration, short, usdc } from "../lib/format";
import { useNow, type Resource } from "../lib/hooks";
import { useApp } from "../lib/store";
import { Http } from "./common";

/**
 * The access pass: PayGate's one signature object. Unheld it reads as an offer (price, window);
 * held it turns USDC blue and the stub counts down to expiry.
 */
export function Pass({ r, until, holder, preview, kicker, className }: { r: Resource | null; until: number; holder?: string | null; preview?: boolean; kicker?: string; className?: string }) {
  const now = useNow();
  const { net } = useApp();
  const left = Math.max(0, until - now);
  const held = left > 0;
  const frac = r && held ? Math.min(1, left / Math.max(1, r.window)) : 0;
  const notch = held ? "bg-background" : "bg-background border";

  return (
    <div className={cn("@container", className)}>
      <div
        aria-label={held ? "Active access pass" : "Access pass offer"}
        className={cn(
          "relative flex overflow-hidden rounded-2xl border transition-colors duration-500",
          held ? "border-transparent bg-[#1f5fb8] text-white" : "bg-card",
        )}
      >
        <div className="min-w-0 flex-1 p-5 @md:p-6">
          <div className="flex items-center justify-between gap-2">
            <span className={cn("font-mono text-[10.5px] uppercase tracking-[0.16em]", held ? "text-white/70" : "text-muted-foreground")}>
              {kicker ?? (preview ? "Preview" : `Pass · ${net.short}`)}
            </span>
            {held ? (
              <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-semibold backdrop-blur">Valid</span>
            ) : (
              <Http code={402} />
            )}
          </div>
          <div className="mt-4 min-w-0">
            <div className="truncate text-lg font-semibold tracking-tight @md:text-xl">{r ? r.meta.name : "Resource"}</div>
            <div className={cn("truncate font-mono text-xs", held ? "text-white/65" : "text-muted-foreground")}>
              {r?.meta.host ? `${r.meta.host}${r.meta.path ?? ""}` : preview ? "endpoint not set" : r ? `resource #${r.id}` : "—"}
            </div>
          </div>
          <dl className="mt-5 grid grid-cols-3 gap-3 text-sm">
            {[
              ["Price", r ? `${usdc(r.price)}` : "—"],
              ["Window", r ? duration(r.window) : "—"],
              [held ? "Holder" : "Sold", held ? short(holder, 4, 3) : r ? Number(r.sales).toLocaleString() : "—"],
            ].map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className={cn("text-[10.5px] font-medium uppercase tracking-wider", held ? "text-white/60" : "text-muted-foreground")}>{k}</dt>
                <dd className="mt-0.5 truncate font-mono text-[13px]">{v}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className={cn("relative flex w-28 shrink-0 flex-col items-center justify-center gap-1 border-l border-dashed px-3 @md:w-32", held ? "border-white/30" : "border-border")}>
          <span className={cn("absolute -top-3 -left-3 size-6 rounded-full", notch)} aria-hidden="true" />
          <span className={cn("absolute -bottom-3 -left-3 size-6 rounded-full", notch)} aria-hidden="true" />
          {held ? (
            <>
              <span className="text-[10.5px] uppercase tracking-wider text-white/70">Expires in</span>
              <span className="font-mono text-xl font-semibold tabular-nums @md:text-2xl">{countdown(left)}</span>
              <div className="mt-1 h-1 w-16 overflow-hidden rounded-full bg-white/20" aria-hidden="true">
                <div className="h-full rounded-full bg-white transition-[width] duration-1000 ease-linear" style={{ width: `${frac * 100}%` }} />
              </div>
            </>
          ) : (
            <>
              <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground">Pay</span>
              <span className="font-mono text-2xl font-semibold tabular-nums">{r ? usdc(r.price) : "—"}</span>
              <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground">USDC</span>
            </>
          )}
        </div>

      </div>
    </div>
  );
}
