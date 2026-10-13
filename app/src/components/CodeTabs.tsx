import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CopyButton } from "./common";

export interface CodeTab {
  key: string;
  label: string;
  plain: string;
  rich?: ReactNode;
}

/** A dark code window with a tab strip and a copy button; the same look in light and dark mode. */
export function CodeTabs({ tabs, className, title }: { tabs: CodeTab[]; className?: string; title?: string }) {
  const [k, setK] = useState(tabs[0].key);
  const t = tabs.find((x) => x.key === k) ?? tabs[0];
  return (
    <div className={cn("overflow-hidden rounded-xl border border-white/10 bg-[#0b0f17] text-[#d6deeb] shadow-xl shadow-black/10", className)}>
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <div className="mr-1 flex gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
        </div>
        {title && tabs.length === 1 ? (
          <span className="font-mono text-xs text-white/50">{title}</span>
        ) : (
          <div className="flex gap-1" role="tablist">
            {tabs.map((x) => (
              <button
                key={x.key}
                role="tab"
                aria-selected={x.key === k}
                onClick={() => setK(x.key)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  x.key === k ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80",
                )}
              >
                {x.label}
              </button>
            ))}
          </div>
        )}
        <CopyButton text={t.plain} label="Copy code" className="ml-auto text-white/50 hover:bg-white/10 hover:text-white" />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed">{t.rich ?? t.plain}</pre>
    </div>
  );
}

/** Syntax tints for hand-highlighted snippets. */
export const tok = {
  c: "text-white/40",
  k: "text-[#c792ea]",
  s: "text-[#addb67]",
  n: "text-[#f78c6c]",
  f: "text-[#82aaff]",
};
