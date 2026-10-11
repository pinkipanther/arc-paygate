import { useApp } from "../lib/store";
import { Alert, Check, External, X } from "./icons";
import { Spinner } from "./ui";

export function Toasts() {
  const { toasts, dismiss } = useApp();
  return (
    <div className="toasts" aria-live="polite" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span className="ic">{t.tone === "pending" ? <Spinner /> : t.tone === "ok" ? <Check /> : <Alert />}</span>
          <div style={{ minWidth: 0 }}>
            <b>{t.title}</b>
            {t.body && <span>{t.body}</span>}
            {t.href && (
              <a href={t.href} target="_blank" rel="noopener noreferrer" style={{ fontSize: "0.82rem", display: "inline-flex", gap: 4, alignItems: "center", marginTop: 4 }}>
                View transaction <External width={12} height={12} />
              </a>
            )}
          </div>
          <button className="iconbtn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}
