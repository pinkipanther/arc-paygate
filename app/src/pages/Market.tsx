import { useMemo, useState } from "react";
import { Box, Plus } from "../components/icons";
import { NotDeployed } from "../components/NotDeployed";
import { ResourceRow, ResourceRowSkeleton } from "../components/ResourceRow";
import { Empty } from "../components/ui";
import { useResources } from "../lib/hooks";
import { useApp } from "../lib/store";

type Sort = "new" | "sold" | "cheap" | "pricey";

export function Market() {
  const { net } = useApp();
  const res = useResources();
  const [q, setQ] = useState("");
  const [onlyLive, setOnlyLive] = useState(true);
  const [sort, setSort] = useState<Sort>("sold");

  const rows = useMemo(() => {
    let xs = res.data ?? [];
    if (onlyLive) xs = xs.filter((r) => r.active);
    const s = q.trim().toLowerCase();
    if (s) xs = xs.filter((r) => [r.meta.name, r.meta.desc, r.meta.host ?? "", r.seller, `#${r.id}`].join(" ").toLowerCase().includes(s));
    const cmp: Record<Sort, (a: (typeof xs)[0], b: (typeof xs)[0]) => number> = {
      new: (a, b) => Number(b.id - a.id),
      sold: (a, b) => Number(b.sales - a.sales) || Number(b.id - a.id),
      cheap: (a, b) => (a.price === b.price ? 0 : a.price < b.price ? -1 : 1),
      pricey: (a, b) => (a.price === b.price ? 0 : a.price > b.price ? -1 : 1),
    };
    return [...xs].sort(cmp[sort]);
  }, [res.data, q, onlyLive, sort]);

  return (
    <div className="wrap">
      <div className="page-h">
        <div>
          <h1>Marketplace</h1>
          <p>Everything for sale through PayGate on {net.label}. Each listing is a resource id on-chain with a price and an access window.</p>
        </div>
        <a className="btn btn-primary" href="#/sell">
          <Plus /> List a resource
        </a>
      </div>

      {!net.contract ? (
        <NotDeployed />
      ) : (
        <>
          <div className="spread" style={{ marginBottom: 16 }}>
            <input className="input" style={{ maxWidth: 340 }} placeholder="Search by name, host, seller or #id" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search resources" />
            <div className="row">
              <div className="seg" role="group" aria-label="Status filter">
                <button aria-pressed={onlyLive} onClick={() => setOnlyLive(true)}>
                  On sale
                </button>
                <button aria-pressed={!onlyLive} onClick={() => setOnlyLive(false)}>
                  All
                </button>
              </div>
              <select className="select" style={{ width: "auto", height: 38, padding: "0 12px" }} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
                <option value="sold">Most sold</option>
                <option value="new">Newest</option>
                <option value="cheap">Price, low to high</option>
                <option value="pricey">Price, high to low</option>
              </select>
            </div>
          </div>

          {res.error && !res.data && (
            <div className="banner" style={{ marginBottom: 16 }}>
              Couldn't read the contract: {res.error}
              <button className="btn btn-secondary btn-sm" onClick={res.reload}>
                Retry
              </button>
            </div>
          )}

          <div className="res-list">
            {res.loading && !res.data
              ? [0, 1, 2].map((i) => <ResourceRowSkeleton key={i} />)
              : rows.map((r) => <ResourceRow key={r.id.toString()} r={r} />)}
          </div>

          {res.data && rows.length === 0 && (
            <div className="card">
              {res.data.length === 0 ? (
                <Empty icon={<Box />} title="Nothing listed yet" action={<a className="btn btn-primary" href="#/sell">List the first resource</a>}>
                  Any API, dataset or file can be sold by the hour. Listing costs one transaction.
                </Empty>
              ) : (
                <Empty icon={<Box />} title="No matches">
                  Nothing matches “{q}”{onlyLive ? " among resources on sale" : ""}.
                </Empty>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
