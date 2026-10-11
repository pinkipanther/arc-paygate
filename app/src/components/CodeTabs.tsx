import { useState, type ReactNode } from "react";
import { CopyButton } from "./ui";

export interface CodeTab {
  key: string;
  label: string;
  plain: string;
  rich?: ReactNode;
}

export function CodeTabs({ tabs }: { tabs: CodeTab[] }) {
  const [k, setK] = useState(tabs[0].key);
  const t = tabs.find((x) => x.key === k) ?? tabs[0];
  return (
    <div>
      <div className="codehead">
        <div className="seg" role="tablist">
          {tabs.map((x) => (
            <button key={x.key} role="tab" aria-selected={x.key === k} onClick={() => setK(x.key)}>
              {x.label}
            </button>
          ))}
        </div>
        <CopyButton text={t.plain} label="Copy code" />
      </div>
      <pre className="code">{t.rich ?? t.plain}</pre>
    </div>
  );
}
