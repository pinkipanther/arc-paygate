import { useMemo, useState } from "react";
import { ArrowUpRight, PackageOpen, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Empty, PageHeader, StatusBadge } from "../components/common";
import { NotDeployed } from "../components/NotDeployed";
import { intFmt, perWindow, usdc } from "../lib/format";
import { useResources, type Resource } from "../lib/hooks";
import { useApp } from "../lib/store";

type Sort = "new" | "sold" | "cheap" | "pricey";

function ResourceCard({ r }: { r: Resource }) {
  return (
    <a href={`#/r/${r.id}`} className="group block h-full">
      <div className="h-full rounded-xl border bg-card transition-colors group-hover:border-foreground/20">
        <div className="flex h-full flex-col p-5">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="font-mono">
              #{r.id.toString()}
            </Badge>
            {r.meta.kind && (
              <Badge variant="outline" className="capitalize">
                {r.meta.kind === "api" ? "API" : r.meta.kind}
              </Badge>
            )}
            <ArrowUpRight className="ml-auto size-4 text-muted-foreground group-hover:text-foreground" />
          </div>
          <h3 className="mt-4 text-lg font-semibold tracking-tight">{r.meta.name}</h3>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{r.meta.desc || r.meta.host || "No endpoint listed"}</p>
          <div className="mt-auto flex items-end justify-between gap-3 pt-6">
            <div>
              <div className="font-mono text-2xl font-semibold tracking-tight tabular-nums">{usdc(r.price)}</div>
              <div className="text-xs text-muted-foreground">USDC / {perWindow(r.window)}</div>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <StatusBadge active={r.active} />
              <span className="text-xs text-muted-foreground">{intFmt(r.sales)} sold</span>
            </div>
          </div>
        </div>
      </div>
    </a>
  );
}

export function Market() {
  const { net, setNet } = useApp();
  const res = useResources();
  const [q, setQ] = useState("");
  const [onlyLive, setOnlyLive] = useState(true);
  const [sort, setSort] = useState<Sort>("sold");

  const rows = useMemo(() => {
    let xs = res.data ?? [];
    if (onlyLive) xs = xs.filter((r) => r.active);
    const s = q.trim().toLowerCase();
    if (s) xs = xs.filter((r) => [r.meta.name, r.meta.desc, r.meta.host ?? "", r.seller, `#${r.id}`].join(" ").toLowerCase().includes(s));
    const cmp: Record<Sort, (a: Resource, b: Resource) => number> = {
      new: (a, b) => Number(b.id - a.id),
      sold: (a, b) => Number(b.sales - a.sales) || Number(b.id - a.id),
      cheap: (a, b) => (a.price === b.price ? 0 : a.price < b.price ? -1 : 1),
      pricey: (a, b) => (a.price === b.price ? 0 : a.price > b.price ? -1 : 1),
    };
    return [...xs].sort(cmp[sort]);
  }, [res.data, q, onlyLive, sort]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <PageHeader
        title="Marketplace"
        sub="APIs and datasets you can unlock by the hour."
        action={
          <Button asChild className="rounded-full">
            <a href="#/sell">
              <Plus className="size-4" /> List yours
            </a>
          </Button>
        }
      />

      {!net.contract ? (
        <NotDeployed />
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-10 rounded-full pl-9" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search resources" />
            </div>
            <Tabs value={onlyLive ? "live" : "all"} onValueChange={(v) => setOnlyLive(v === "live")} className="ml-auto">
              <TabsList className="rounded-full">
                <TabsTrigger value="live" className="rounded-full">
                  On sale
                </TabsTrigger>
                <TabsTrigger value="all" className="rounded-full">
                  All
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
              <SelectTrigger className="h-10 w-40 rounded-full" aria-label="Sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sold">Most sold</SelectItem>
                <SelectItem value="new">Newest</SelectItem>
                <SelectItem value="cheap">Cheapest</SelectItem>
                <SelectItem value="pricey">Priciest</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {res.error && !res.data && (
            <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
              Couldn't read the contract.
              <Button variant="outline" size="sm" onClick={res.reload}>
                Retry
              </Button>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {res.loading && !res.data
              ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-52 rounded-xl" />)
              : rows.map((r) => (
                  <ResourceCard key={r.id.toString()} r={r} />
                ))}
          </div>

          {res.data && rows.length === 0 && (
            <div className="rounded-xl border">
              {res.data.length === 0 ? (
                <Empty
                  icon={<PackageOpen />}
                  title="Nothing listed yet"
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button asChild className="rounded-full">
                        <a href="#/sell">List the first one</a>
                      </Button>
                      {!net.simulated && (
                        <Button variant="outline" className="rounded-full" onClick={() => setNet("demo")}>
                          Try the demo
                        </Button>
                      )}
                    </div>
                  }
                />
              ) : (
                <Empty icon={<Search />} title="No matches">
                  Nothing matches “{q}”.
                </Empty>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
