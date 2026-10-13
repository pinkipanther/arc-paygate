import { useMemo, useState, type ReactNode } from "react";
import { ArrowDownToLine, ArrowRightLeft, PencilLine, PlusCircle, Ticket, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Empty, PageHeader, TxLink } from "../components/common";
import { NotDeployed } from "../components/NotDeployed";
import { ago, dateTime, intFmt, perWindow, sameAddr, short, usdc } from "../lib/format";
import { useActivity, useResources, type ActivityItem } from "../lib/hooks";
import { useApp } from "../lib/store";

type Filter = "all" | "pay" | "list" | "out";
const KIND: Record<ActivityItem["kind"], { label: string; cls: string; icon: typeof Zap; group: Filter }> = {
  Paid: { label: "Pass bought", cls: "bg-success/12 text-success", icon: Zap, group: "pay" },
  ResourceCreated: { label: "Listed", cls: "bg-primary/12 text-primary", icon: PlusCircle, group: "list" },
  ResourceUpdated: { label: "Updated", cls: "bg-muted text-muted-foreground", icon: PencilLine, group: "list" },
  ResourceTransferred: { label: "Transferred", cls: "bg-warning/15 text-warning", icon: ArrowRightLeft, group: "list" },
  Withdrawn: { label: "Withdrawn", cls: "bg-brand-2/12 text-brand-2", icon: ArrowDownToLine, group: "out" },
};

function Kind({ k }: { k: ActivityItem["kind"] }) {
  const m = KIND[k];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap", m.cls)}>
      <m.icon className="size-3.5" />
      {m.label}
    </span>
  );
}

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
      <a href={`#/r/${k}`} className="font-medium hover:text-primary">
        {names.get(k) ?? `#${k}`}
      </a>
    );
  };

  function detail(x: ActivityItem): [ReactNode, string] {
    const a = x.args;
    switch (x.kind) {
      case "Paid":
        return [nameOf(a.id), `${a.payer === a.beneficiary ? short(a.payer as string) : `${short(a.payer as string)} → ${short(a.beneficiary as string)}`} · until ${dateTime(a.until as bigint)}`];
      case "ResourceCreated":
      case "ResourceUpdated":
        return [nameOf(a.id), `${usdc(a.price as bigint)} USDC / ${perWindow(Number(a.window))}${x.kind === "ResourceUpdated" && a.active === false ? " · paused" : ""}`];
      case "ResourceTransferred":
        return [nameOf(a.id), `${short(a.from as string)} → ${short(a.to as string)}`];
      case "Withdrawn":
        return [<span className="font-mono text-sm">{short(a.seller as string)}</span>, sameAddr(a.seller as string, a.to as string) ? "to own wallet" : `to ${short(a.to as string)}`];
    }
  }

  const amount = (x: ActivityItem) => (x.kind === "Paid" || x.kind === "Withdrawn" ? usdc(x.args.amount as bigint) : null);

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <PageHeader
        title="Activity"
        sub="Every pass, listing and withdrawal, straight from contract events."
        action={
          <Tabs value={f} onValueChange={(v) => setF(v as Filter)}>
            <TabsList className="rounded-full">
              {(
                [
                  ["all", "All"],
                  ["pay", "Passes"],
                  ["list", "Listings"],
                  ["out", "Payouts"],
                ] as [Filter, string][]
              ).map(([k, l]) => (
                <TabsTrigger key={k} value={k} className="rounded-full">
                  {l}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      />

      {!net.contract ? (
        <NotDeployed />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          {act.error && (
            <div className="flex items-center justify-between gap-3 border-b bg-destructive/5 p-4 text-sm">
              Some history didn't load.
              <Button variant="outline" size="sm" onClick={act.reload}>
                Retry
              </Button>
            </div>
          )}
          {act.loading && !act.data ? (
            <div className="space-y-3 p-5">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <Empty icon={<Ticket />} title="No activity yet">
              Events show up seconds after they settle.
            </Empty>
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-5">Event</TableHead>
                      <TableHead>Details</TableHead>
                      <TableHead className="text-right">USDC</TableHead>
                      <TableHead>When</TableHead>
                      <TableHead className="pr-5">Tx</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((x) => {
                      const [title, sub] = detail(x);
                      const amt = amount(x);
                      return (
                        <TableRow key={`${x.tx}-${x.logIndex}`}>
                          <TableCell className="pl-5">
                            <Kind k={x.kind} />
                          </TableCell>
                          <TableCell className="whitespace-normal">
                            <div>{title}</div>
                            <div className="text-xs text-muted-foreground">{sub}</div>
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">{amt ?? <span className="text-muted-foreground">—</span>}</TableCell>
                          <TableCell>
                            <div className="text-sm">{x.time ? ago(x.time) : "—"}</div>
                            <div className="font-mono text-[11px] text-muted-foreground">#{intFmt(x.block)}</div>
                          </TableCell>
                          <TableCell className="pr-5">
                            <TxLink hash={x.tx} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <ul className="divide-y md:hidden">
                {rows.map((x) => {
                  const [title, sub] = detail(x);
                  const amt = amount(x);
                  return (
                      <li key={`${x.tx}-${x.logIndex}`} className="flex items-start gap-3 p-4">
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <Kind k={x.kind} />
                          <div className="text-sm">{title}</div>
                          <div className="text-xs text-muted-foreground">{sub}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          {amt && <div className="font-mono text-sm tabular-nums">{amt}</div>}
                          <div className="text-xs text-muted-foreground">{x.time ? ago(x.time) : ""}</div>
                        </div>
                      </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
