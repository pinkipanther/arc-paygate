import { intFmt, perWindow, usdc } from "../lib/format";
import type { Resource } from "../lib/hooks";
import { StatusPill } from "./ui";

export function ResourceRow({ r }: { r: Resource }) {
  return (
    <a className="res" href={`#/r/${r.id}`}>
      <span className="res-icon">#{r.id.toString()}</span>
      <span style={{ minWidth: 0 }}>
        <div className="res-title">{r.meta.name}</div>
        <div className="res-sub">{r.meta.desc || (r.meta.host ? `${r.meta.host}${r.meta.path ?? ""}` : "No endpoint listed")}</div>
      </span>
      <span className="res-meta">
        <StatusPill active={r.active} />
        <span className="pill">{intFmt(r.sales)} sold</span>
      </span>
      <span className="res-price">
        <div className="p num">{usdc(r.price)} USDC</div>
        <div className="w">per {perWindow(r.window)}</div>
      </span>
    </a>
  );
}

export function ResourceRowSkeleton() {
  return (
    <div className="res" aria-hidden="true">
      <span className="skel" style={{ width: 44, height: 44, borderRadius: 12 }} />
      <span className="stack" style={{ gap: 8 }}>
        <span className="skel" style={{ width: "40%", height: 14 }} />
        <span className="skel" style={{ width: "65%", height: 12 }} />
      </span>
      <span className="res-meta">
        <span className="skel" style={{ width: 70, height: 22, borderRadius: 999 }} />
      </span>
      <span className="skel" style={{ width: 90, height: 30 }} />
    </div>
  );
}
