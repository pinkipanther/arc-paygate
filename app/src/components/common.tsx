import { useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { short } from "../lib/format";
import { useApp } from "../lib/store";

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("size-7 text-muted-foreground hover:text-foreground", className)}
          aria-label={label}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setDone(true);
              setTimeout(() => setDone(false), 1400);
            } catch {
              /* clipboard blocked: nothing useful to do */
            }
          }}
        >
          {done ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{done ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}

export function Address({ value, link = true, full = false, className }: { value: string; link?: boolean; full?: boolean; className?: string }) {
  const { net } = useApp();
  const text = full ? value : short(value);
  return (
    <span className={cn("inline-flex items-center gap-0.5 font-mono text-[0.85em]", className)} title={value}>
      {link && net.explorer ? (
        <a className="hover:text-primary hover:underline underline-offset-4" href={`${net.explorer}/address/${value}`} target="_blank" rel="noopener noreferrer">
          {text}
        </a>
      ) : (
        <span>{text}</span>
      )}
      <CopyButton text={value} label="Copy address" />
    </span>
  );
}

export function TxLink({ hash }: { hash: string }) {
  const { net } = useApp();
  if (!net.explorer) return <span className="font-mono text-xs text-muted-foreground">{short(hash, 8, 6)}</span>;
  return (
    <a className="font-mono text-xs hover:text-primary hover:underline underline-offset-4" href={`${net.explorer}/tx/${hash}`} target="_blank" rel="noopener noreferrer">
      {short(hash, 8, 6)}
    </a>
  );
}

export function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn("inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground", className)}>
      {children}
      <ExternalLink className="size-3.5" />
    </a>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && <div className="grid size-10 place-items-center rounded-lg border text-muted-foreground [&_svg]:size-5">{icon}</div>}
      <h3 className="font-semibold tracking-tight">{title}</h3>
      {children && <p className="max-w-sm text-sm text-muted-foreground">{children}</p>}
      {action}
    </div>
  );
}

export function StatusBadge({ active }: { active: boolean }) {
  return active ? (
    <Badge variant="outline" className="gap-1.5 border-success/30 bg-success/10 text-success">
      <span className="size-1.5 rounded-full bg-success" />
      On sale
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1.5 text-muted-foreground">
      <span className="size-1.5 rounded-full bg-muted-foreground" />
      Paused
    </Badge>
  );
}

export function Http({ code }: { code: 200 | 402 | number }) {
  const ok = code === 200;
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-md px-1.5 font-mono text-[11px] font-semibold",
        ok ? "bg-success/12 text-success" : "bg-warning/15 text-warning",
      )}
    >
      {code}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin", className)} aria-hidden="true" />;
}

/** Page title block used at the top of every inner page. */
export function PageHeader({ title, sub, action, eyebrow }: { title: ReactNode; sub?: ReactNode; action?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-3">{eyebrow}</div>}
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
        {sub && <p className="mt-2 max-w-xl text-muted-foreground">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground", className)}>{children}</span>;
}
