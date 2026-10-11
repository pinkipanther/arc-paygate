import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, External, X } from "./icons";
import { short } from "../lib/format";
import { useApp } from "../lib/store";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="iconbtn"
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          window.prompt?.("Copy this", text);
        }
      }}
    >
      {done ? <Check /> : <Copy />}
    </button>
  );
}

export function Address({ value, link = true, full = false }: { value: string; link?: boolean; full?: boolean }) {
  const { net } = useApp();
  const text = full ? value : short(value);
  return (
    <span className="addr" title={value}>
      {link && net.explorer ? (
        <a href={`${net.explorer}/address/${value}`} target="_blank" rel="noopener noreferrer">
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
  if (!net.explorer) return <span className="mono">{short(hash, 8, 6)}</span>;
  return (
    <a className="mono" href={`${net.explorer}/tx/${hash}`} target="_blank" rel="noopener noreferrer">
      {short(hash, 8, 6)}
    </a>
  );
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="row" style={{ gap: 4, display: "inline-flex" }}>
      {children}
      <External width={13} height={13} />
    </a>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="art">{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Skel({ w = "100%", h = 14 }: { w?: number | string; h?: number }) {
  return <div className="skel" style={{ width: w, height: h }} />;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", k);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="card-h">
          <h3>{title}</h3>
          <button className="iconbtn" aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="card-b">{children}</div>
      </div>
    </div>
  );
}

export function StatusPill({ active }: { active: boolean }) {
  return active ? (
    <span className="pill ok">
      <span className="dot ok" />
      On sale
    </span>
  ) : (
    <span className="pill">
      <span className="dot" />
      Paused
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
