import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * PayGate's mark: an access pass on a USDC-blue tile. `full` adds the "402" the pass answers with;
 * the compact form (ticket + check) stays legible down to favicon size.
 */
export function LogoMark({ className, full = false }: { className?: string; full?: boolean }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 480 480" className={cn("size-8 shrink-0", className)} role="img" aria-label="PayGate">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2f80d8" />
          <stop offset="1" stopColor="#0f2c52" />
        </linearGradient>
        <mask id={`m${id}`}>
          <rect width="480" height="480" fill="#fff" />
          <circle cx="96" cy="240" r="26" fill="#000" />
          <circle cx="384" cy="240" r="26" fill="#000" />
        </mask>
      </defs>
      <rect width="480" height="480" rx="108" fill={`url(#g${id})`} />
      <g mask={`url(#m${id})`}>
        <rect x="96" y="140" width="288" height="200" rx="28" fill="#fff" />
      </g>
      <line x1="296" y1="160" x2="296" y2="320" stroke="#2775ca" strokeWidth="6" strokeDasharray="4 12" strokeLinecap="round" />
      {full ? (
        <>
          <text x="206" y="264" textAnchor="middle" fontFamily="Geist Variable, ui-sans-serif, system-ui" fontWeight="760" fontSize="66" fill="#0f2c52" letterSpacing="-3">
            402
          </text>
          <path d="M314 242 l11 11 l21 -24" fill="none" stroke="#2775ca" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <path d="M150 244 l40 40 l70 -84" fill="none" stroke="#0f2c52" strokeWidth="30" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 font-semibold tracking-tight", className)}>
      <LogoMark className="size-8" />
      <span className="text-[1.05rem]">PayGate</span>
    </span>
  );
}
