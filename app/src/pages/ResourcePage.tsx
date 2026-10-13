import { useEffect, type ReactNode } from "react";
import { ArrowLeft, PackageX, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BuyPanel } from "../components/BuyPanel";
import { CodeTabs } from "../components/CodeTabs";
import { NotDeployed } from "../components/NotDeployed";
import { Pass } from "../components/Pass";
import { UsePass } from "../components/UsePass";
import { Address, CopyButton, Empty, ExtLink, Http, StatusBadge } from "../components/common";
import { duration, intFmt, sameAddr, usdc } from "../lib/format";
import { useAccess, useNow, useResource } from "../lib/hooks";
import { useApp } from "../lib/store";

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-2.5 text-sm">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

export function ResourcePage({ id }: { id: bigint }) {
  const { net, wallet } = useApp();
  const res = useResource(id);
  const access = useAccess(id);
  const now = useNow();
  const r = res.data;
  const held = access.until > now;
  const mine = r && sameAddr(r.seller, wallet?.address);
  useEffect(() => {
    document.title = `${r ? r.meta.name : `Resource #${id}`} · PayGate`;
  }, [r, id]);

  const wrap = (c: ReactNode) => <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">{c}</div>;

  if (!net.contract) return wrap(<NotDeployed />);

  if (res.loading && !r)
    return wrap(
      <div className="space-y-6">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-10 w-1/2" />
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-80 rounded-xl" />
        </div>
      </div>,
    );

  if (!r)
    return wrap(
      <div className="rounded-xl border">
        <Empty
          icon={<PackageX />}
          title={`No resource #${id} on ${net.label}`}
          action={
            <Button asChild variant="outline" className="rounded-full">
              <a href="#/market">Back to the market</a>
            </Button>
          }
        />
      </div>,
    );

  const pyCmd = `python py/client.py fetch ${r.meta.url ?? "https://<seller-host>/<path>"} \\\n  --contract ${net.contract} --max-usdc ${usdc(r.price * 2n)}`;
  const solCheck = `// gate anything with one view call\nbool ok = PayGate(${net.contract}).hasAccess(buyer, ${r.id});`;

  const details = (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle>Details</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-10 sm:grid-cols-2">
          <Row k="Price">
            <span className="font-mono">{usdc(r.price)} USDC</span>
          </Row>
          <Row k="Window">{duration(r.window)}</Row>
          <Row k="Sold">{intFmt(r.sales)}</Row>
          <Row k="Revenue">
            <span className="font-mono">{usdc(r.revenue)} USDC</span>
          </Row>
          <Row k="Seller">
            <Address value={r.seller} />
          </Row>
          {r.meta.url && (
            <Row k="Endpoint">
              <span className="inline-flex max-w-full items-center">
                <span className="truncate font-mono text-xs">{r.meta.host}</span>
                <CopyButton text={r.meta.url} label="Copy endpoint" />
              </span>
            </Row>
          )}
        </dl>
      </CardContent>
    </Card>
  );

  return wrap(
    <>
      <a href="#/market" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Market
      </a>

        <div className="mt-5 mb-8 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="font-mono">
                #{r.id.toString()}
              </Badge>
              <StatusBadge active={r.active} />
              {r.meta.kind && (
                <Badge variant="outline" className="capitalize">
                  {r.meta.kind === "api" ? "API" : r.meta.kind}
                </Badge>
              )}
              {mine && <Badge className="bg-warning/15 text-warning hover:bg-warning/15">You sell this</Badge>}
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{r.meta.name}</h1>
            {r.meta.desc && <p className="mt-2 max-w-2xl text-muted-foreground">{r.meta.desc}</p>}
          </div>
          {mine && (
            <Button asChild variant="outline" className="rounded-full">
              <a href="#/sell">
                <Settings2 className="size-4" /> Manage
              </a>
            </Button>
          )}
        </div>

      {/* One DOM order for every width: pass, buy, use, details, integrate. On desktop the buy panel moves to the
          right column and sticks; the last row takes the leftover height so the left cards stay evenly spaced. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-[auto_auto_auto_1fr]">
        <div className="min-w-0 lg:col-start-1">
          <Pass r={r} until={access.until} holder={wallet?.address} />
        </div>

        <aside className="lg:sticky lg:top-24 lg:col-start-2 lg:row-span-4 lg:row-start-1">
          <BuyPanel r={r} held={held} onBought={access.reload} />
        </aside>

        <Card className="min-w-0 rounded-xl lg:col-start-1">
          <CardHeader>
            <CardTitle>Use your pass</CardTitle>
            <CardAction>
              <Http code={held ? 200 : 402} />
            </CardAction>
          </CardHeader>
          <CardContent>
            <UsePass r={r} held={held} />
          </CardContent>
        </Card>

        <div className="min-w-0 lg:col-start-1">{details}</div>

        <Card className="min-w-0 rounded-xl lg:col-start-1">
          <CardHeader>
            <CardTitle>Integrate</CardTitle>
            {net.explorer && (
              <CardAction>
                <ExtLink href={`${net.explorer}/address/${net.contract}`}>Explorer</ExtLink>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            <CodeTabs
              tabs={[
                { key: "py", label: "Python", plain: pyCmd },
                { key: "sol", label: "Solidity", plain: solCheck },
                { key: "raw", label: "Raw", plain: `to:    ${net.contract}\ndata:  pay(${r.id}, ${r.window})\nvalue: ${r.price} wei\nchain: ${net.chain.id}` },
              ]}
            />
            {net.simulated && <p className="text-xs text-muted-foreground">Demo contract lives in this tab only.</p>}
          </CardContent>
        </Card>
      </div>
    </>,
  );
}
