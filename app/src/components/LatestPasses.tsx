import { useActivity, type Resource } from "../lib/hooks";
import { ago, short, usdc } from "../lib/format";

/** Small live feed of the most recent purchases, shown under the hero pass. */
export function LatestPasses({ resources }: { resources: Resource[] }) {
  const act = useActivity(24);
  const names = new Map(resources.map((r) => [r.id.toString(), r.meta.name]));
  const paid = (act.data ?? []).filter((x) => x.kind === "Paid").slice(0, 4);
  if (act.loading && !act.data) return <div className="skel" style={{ height: 150, borderRadius: 14 }} />;
  if (paid.length === 0) return null;
  return (
    <div className="card" style={{ borderRadius: 14 }}>
      <div className="spread" style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)" }}>
        <span className="eyebrow">Latest passes</span>
        <a href="#/activity" style={{ fontSize: "0.82rem" }}>
          All activity
        </a>
      </div>
      <div>
        {paid.map((x) => {
          const id = String(x.args.id);
          return (
            <a
              key={`${x.tx}-${x.logIndex}`}
              href={`#/r/${id}`}
              className="spread"
              style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)", color: "var(--ink)", textDecoration: "none", flexWrap: "nowrap" }}
            >
              <span style={{ minWidth: 0, overflow: "hidden" }}>
                <div style={{ fontWeight: 600, fontSize: "0.9rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{names.get(id) ?? `#${id}`}</div>
                <div className="muted mono" style={{ fontSize: "0.76rem" }}>
                  {short(x.args.beneficiary as string)} {x.time ? `· ${ago(x.time)}` : ""}
                </div>
              </span>
              <span className="mono" style={{ fontSize: "0.86rem", flex: "none" }}>
                {usdc(x.args.amount as bigint)} USDC
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
