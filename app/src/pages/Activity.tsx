import { useMemo, useState } from "react";
import type { Address } from "viem";
import { Ticket } from "../components/icons";
import { NotDeployed } from "../components/NotDeployed";
import { Address as Addr, Empty, TxLink } from "../components/ui";
import { ago, dateTime, intFmt, perWindow, sameAddr, short, usdc } from "../lib/format";
import { useActivity, useResources, type ActivityItem } from "../lib/hooks";
import { useApp } from "../lib/store";

type Filter = "all" | "pay" | "list" | "out";
const KIND: Record<ActivityItem["kind"], { label: string; tone: string; group: Filter }> = {
  Paid: { label: "Pass bought", tone: "ok", group: "pay" },
  ResourceCreated: { label: "Listed", tone: "blue", group: "list" },
  ResourceUpdated: { label: "Updated", tone: "", group: "list" },
  ResourceTransferred: { label: "Transferred", tone: "warn", group: "list" },
  Withdrawn: { label: "Withdrawn", tone: "", group: "out" },
};

export function Activity() {
  const { net } = useApp();
  const act = useActivity(80);
  const res = useResources();
  const [f, setF] = useState<Filter>("all");
  const names = useMemo(() => new Map((res.data ?? []).map((r) => [r.id.toString(), r.meta.name])), [res.data]);
  const rows = (act.data ?? []).filter((x) => f === "all" || KIND[x.kind].group === f);

  const nameOf = (id: unknown) => {
    const k = String(id);
    return (
      <a href={`#/r/${k}`} style={{ fontWeight: 600, color: "var(--ink)" }}>
        {names.get(k) ?? `#${k}`}
      </a>
    );
  };

  function detail(x: ActivityItem) {
    const a = x.args;
    switch (x.kind) {
      case "Paid":
        return (
          <>
            {nameOf(a.id)}
            <div className="muted" style={{ fontSize: "0.8rem" }}>
              {a.payer === a.beneficiary ? short(a.payer as string) : `${short(a.payer as string)} for ${short(a.beneficiary as string)}`} · until {dateTime(a.until as bigint)}
            </div>
          </>
        );
      case "ResourceCreated":
      case "ResourceUpdated":
        return (
          <>
            {nameOf(a.id)}
            <div className="muted" style={{ fontSize: "0.8rem" }}>
              {usdc(a.price as bigint)} USDC per {perWindow(Number(a.window))}{x.kind === "ResourceUpdated" && a.active === false ? " · paused" : ""}
            </div>
          </>
        );
      case "ResourceTransferred":
        return (
          <>
            {nameOf(a.id)}
            <div className="muted" style={{ fontSize: "0.8rem" }}>
              {short(a.from as string)} → {short(a.to as string)}
            </div>
          </>
        );
      case "Withdrawn":
        return (
          <>
            <Addr value={a.seller as Address} link={false} />
            <div className="muted" style={{ fontSize: "0.8rem" }}>
              {sameAddr(a.seller as string, a.to as string) ? "to the seller's own wallet" : `to ${short(a.to as string)}`}
            </div>
          </>
        );
    }
  }

  const amount = (x: ActivityItem) => (x.kind === "Paid" || x.kind === "Withdrawn" ? `${usdc(x.args.amount as bigint)} USDC` : "—");

  return (
    <div className="wrap">
      <div className="page-h">
        <div>
          <h1>Activity</h1>
          <p>Every purchase, listing and withdrawal on {net.label}, read straight from the contract's events.</p>
        </div>
        <div className="seg" role="group" aria-label="Filter">
          {(
            [
              ["all", "All"],
              ["pay", "Purchases"],
              ["list", "Listings"],
              ["out", "Withdrawals"],
            ] as [Filter, string][]
          ).map(([k, l]) => (
            <button key={k} aria-pressed={f === k} onClick={() => setF(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {!net.contract ? (
        <NotDeployed />
      ) : (
        <div className="card">
          {act.error && (
            <div className="banner" style={{ margin: 16 }}>
              Some history couldn't load: {act.error}
              <button className="btn btn-secondary btn-sm" onClick={act.reload}>
                Retry
              </button>
            </div>
          )}
          {act.loading && !act.data ? (
            <div className="card-b stack">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skel" style={{ height: 40 }} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <Empty icon={<Ticket />} title="No activity yet">
              Purchases, listings and withdrawals appear here a few seconds after they settle.
            </Empty>
          ) : (
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Details</th>
                    <th className="r">Amount</th>
                    <th>When</th>
                    <th>Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x) => (
                    <tr key={`${x.tx}-${x.logIndex}`}>
                      <td>
                        <span className={`pill ${KIND[x.kind].tone}`}>{KIND[x.kind].label}</span>
                      </td>
                      <td style={{ whiteSpace: "normal", minWidth: 220 }}>{detail(x)}</td>
                      <td className="r mono">{amount(x)}</td>
                      <td>
                        <div>{x.time ? ago(x.time) : "—"}</div>
                        <div className="muted mono" style={{ fontSize: "0.76rem" }}>
                          block {intFmt(x.block)}
                        </div>
                      </td>
                      <td>
                        <TxLink hash={x.tx} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
