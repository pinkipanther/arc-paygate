import { useMemo } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CodeTabs } from "../components/CodeTabs";
import { Eyebrow } from "../components/common";
import { NotDeployed } from "../components/NotDeployed";
import { Pass } from "../components/Pass";
import { ago, intFmt, short, usdc } from "../lib/format";
import { useAccess, useActivity, useChainInfo, useResources, type Resource } from "../lib/hooks";
import { parseMeta } from "../lib/meta";
import { useApp } from "../lib/store";

const SAMPLE: Resource = {
  id: 1n,
  seller: "0x0000000000000000000000000000000000000000",
  price: 10_000_000_000_000_000n,
  window: 3600,
  active: true,
  sales: 0n,
  revenue: 0n,
  uri: "",
  meta: { ...parseMeta("https://api.example.com/api/polymarket-rewards", 1), name: "Polymarket reward pools" },
};

function Recent({ resources }: { resources: Resource[] }) {
  const act = useActivity(24);
  const names = new Map(resources.map((r) => [r.id.toString(), r.meta.name]));
  const paid = (act.data ?? []).filter((x) => x.kind === "Paid").slice(0, 3);
  if (act.loading && !act.data) return <Skeleton className="h-32 rounded-xl" />;
  if (!paid.length) return null;
  return (
    <div className="rounded-xl border">
      <div className="flex items-center justify-between border-b px-4 py-2.5 text-xs text-muted-foreground">
        <span>Recent passes</span>
        <a href="#/activity" className="hover:text-foreground">
          View all
        </a>
      </div>
      <ul className="divide-y">
        {paid.map((x) => {
          const id = String(x.args.id);
          return (
            <li key={`${x.tx}-${x.logIndex}`}>
              <a href={`#/r/${id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-muted/50">
                <span className="min-w-0">
                  <span className="block truncate">{names.get(id) ?? `#${id}`}</span>
                  <span className="block font-mono text-[11px] text-muted-foreground">
                    {short(x.args.beneficiary as string, 5, 4)} {x.time ? `· ${ago(x.time)}` : ""}
                  </span>
                </span>
                <span className="font-mono tabular-nums">{usdc(x.args.amount as bigint)}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const STEPS: [string, string][] = [
  ["Ask", "An unpaid request gets HTTP 402 with the price."],
  ["Pay", "One pay() call on Arc. Gas is paid in USDC too."],
  ["Use", "Sign the request and get 200 until the pass ends."],
];

const WHY: [string, string][] = [
  ["One asset", "USDC pays for the pass and the gas."],
  ["One transaction", "No approve step. pay() is payable."],
  ["Under a cent", "About 61k gas per pass on Arc."],
  ["No middleman", "No owner, no fees, no upgrade key."],
];

export function Home() {
  const { net, wallet, setNet } = useApp();
  const res = useResources();
  const chain = useChainInfo();
  const list = useMemo(() => res.data ?? [], [res.data]);
  const featured = useMemo(() => [...list.filter((r) => r.active)].sort((a, b) => Number(b.sales - a.sales) || Number(a.id - b.id))[0] ?? null, [list]);
  const access = useAccess(featured?.id ?? null);
  const sold = list.reduce((a, r) => a + r.sales, 0n);
  const settled = list.reduce((a, r) => a + r.revenue, 0n);
  const gasPerPass = chain.gasPrice ? chain.gasPrice * 61_000n : null;
  const ready = !!net.contract && !!res.data;
  const contract = (!net.simulated && net.contract) || "0x…";
  const stats: [string, string][] = [
    ["Listings", ready ? intFmt(list.length) : "—"],
    ["Passes sold", ready ? intFmt(sold) : "—"],
    ["Settled (USDC)", ready ? usdc(settled) : "—"],
    ["Gas per pass (USDC)", gasPerPass ? usdc(gasPerPass, 4) : "—"],
  ];

  return (
    <>
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-16 pb-14 sm:px-6 lg:grid-cols-2 lg:pt-24">
        <div>
          <Eyebrow>Native USDC on Arc</Eyebrow>
          <h1 className="mt-4 text-4xl leading-tight font-semibold tracking-tight text-balance sm:text-5xl">Paywall any API. Get paid in USDC.</h1>
          <p className="mt-4 max-w-md text-muted-foreground">One transaction to buy. No approvals, no gas token, no middleman.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            {featured || !ready ? (
              <Button asChild size="lg">
                <a href={featured ? `#/r/${featured.id}` : "#/market"}>
                  {featured ? "Try a pass" : "Browse"} <ArrowRight className="size-4" />
                </a>
              </Button>
            ) : (
              <Button size="lg" onClick={() => setNet("demo")}>
                Try the demo <ArrowRight className="size-4" />
              </Button>
            )}
            <Button asChild size="lg" variant="outline">
              <a href="#/sell">List your API</a>
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          {net.contract ? (
            res.loading && !res.data ? (
              <Skeleton className="h-40 rounded-xl" />
            ) : featured ? (
              <a href={`#/r/${featured.id}`} className="block">
                <Pass r={featured} until={access.until} holder={wallet?.address} />
              </a>
            ) : (
              <>
                <Pass r={SAMPLE} until={0} preview kicker="Example" />
                <p className="text-sm text-muted-foreground">
                  Example pass. Nothing is listed on {net.label} yet:{" "}
                  <a href="#/sell" className="text-foreground underline underline-offset-4">
                    list the first API
                  </a>
                  .
                </p>
              </>
            )
          ) : (
            <>
              <Pass r={SAMPLE} until={0} preview kicker="Example" />
              <NotDeployed />
            </>
          )}
          {net.contract && <Recent resources={list} />}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6">
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-4">
          {stats.map(([k, v]) => (
            <div key={k} className="bg-background p-5">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="mt-1 font-mono text-2xl font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
        <ol className="mt-6 grid gap-6 sm:grid-cols-3">
          {STEPS.map(([t, d], i) => (
            <li key={t}>
              <div className="font-mono text-xs text-muted-foreground">0{i + 1}</div>
              <div className="mt-2 font-medium">{t}</div>
              <p className="mt-1 text-sm text-muted-foreground">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight">Why Arc</h2>
        <div className="mt-6 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2">
          {WHY.map(([t, d]) => (
            <div key={t} className="bg-background p-5">
              <div className="font-medium">{t}</div>
              <p className="mt-1 text-sm text-muted-foreground">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl items-start gap-8 px-4 pb-24 sm:px-6 lg:grid-cols-2">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Buy from a script</h2>
          <p className="mt-2 text-sm text-muted-foreground">The client checks the price on-chain, caps spend, and never signs text from the server.</p>
          <Button asChild variant="link" className="mt-2 px-0">
            <a href="#/agents">
              Integration guide <ArrowRight className="size-4" />
            </a>
          </Button>
        </div>
        <CodeTabs
          tabs={[
            {
              key: "py",
              label: "Python",
              plain: `python py/client.py fetch \\\n  https://api.example.com/api/data \\\n  --contract ${contract} \\\n  --max-usdc 0.05`,
            },
            {
              key: "sol",
              label: "Contract",
              plain: `pay(uint256 id, uint32 minWindow) payable\nhasAccess(address who, uint256 id) view returns (bool)`,
            },
          ]}
        />
      </section>
    </>
  );
}
