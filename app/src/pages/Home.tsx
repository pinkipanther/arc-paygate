import { forwardRef, useMemo, useRef, type ReactNode } from "react";
import { ArrowRight, Bot, Coins, Fingerprint, Landmark, Layers, Server, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { AnimatedBeam } from "@/components/ui/animated-beam";
import { AnimatedGradientText } from "@/components/ui/animated-gradient-text";
import { AnimatedGridPattern } from "@/components/ui/animated-grid-pattern";
import { AnimatedList } from "@/components/ui/animated-list";
import { BlurFade } from "@/components/ui/blur-fade";
import { Button } from "@/components/ui/button";
import { MagicCard } from "@/components/ui/magic-card";
import { Marquee } from "@/components/ui/marquee";
import { NumberTicker } from "@/components/ui/number-ticker";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import { LogoMark } from "../components/brand";
import { CodeTabs, tok } from "../components/CodeTabs";
import { Eyebrow, Http } from "../components/common";
import { NotDeployed } from "../components/NotDeployed";
import { Pass } from "../components/Pass";
import { ago, perWindow, short, usdc } from "../lib/format";
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

const usdcNum = (wei: bigint) => Number(wei) / 1e18;

function LiveFeed({ resources }: { resources: Resource[] }) {
  const act = useActivity(24);
  const names = new Map(resources.map((r) => [r.id.toString(), r.meta.name]));
  const paid = (act.data ?? []).filter((x) => x.kind === "Paid").slice(0, 4).reverse();
  if (act.loading && !act.data) return <Skeleton className="h-48 rounded-2xl" />;
  if (!paid.length) return null;
  return (
    <div className="relative">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
          Latest passes
        </span>
        <a href="#/activity" className="text-xs text-muted-foreground hover:text-foreground">
          All activity →
        </a>
      </div>
      <AnimatedList delay={900} className="gap-2">
        {paid.map((x) => {
          const id = String(x.args.id);
          return (
            <a
              key={`${x.tx}-${x.logIndex}`}
              href={`#/r/${id}`}
              className="flex w-full items-center gap-3 rounded-xl border bg-card/80 p-3 backdrop-blur transition-colors hover:bg-accent/50"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <Zap className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{names.get(id) ?? `#${id}`}</span>
                <span className="block font-mono text-[11px] text-muted-foreground">
                  {short(x.args.beneficiary as string, 5, 4)} {x.time ? `· ${ago(x.time)}` : ""}
                </span>
              </span>
              <span className="font-mono text-sm tabular-nums">{usdc(x.args.amount as bigint)}</span>
            </a>
          );
        })}
      </AnimatedList>
    </div>
  );
}

const Node = forwardRef<HTMLDivElement, { children: ReactNode; label: string; className?: string }>(({ children, label, className }, ref) => (
  <div className="z-10 flex flex-col items-center gap-2">
    <div ref={ref} className={cn("grid size-16 place-items-center rounded-2xl border bg-card shadow-lg shadow-black/5 sm:size-20", className)}>
      {children}
    </div>
    <span className="text-xs font-medium text-muted-foreground">{label}</span>
  </div>
));
Node.displayName = "Node";

function FlowDiagram() {
  const box = useRef<HTMLDivElement>(null);
  const agent = useRef<HTMLDivElement>(null);
  const api = useRef<HTMLDivElement>(null);
  const arc = useRef<HTMLDivElement>(null);
  return (
    <div ref={box} className="relative flex w-full items-center justify-between overflow-hidden rounded-3xl border bg-card/50 px-6 py-14 sm:px-16">
      <Node ref={agent} label="Agent">
        <Bot className="size-7 text-foreground sm:size-8" />
      </Node>
      <Node ref={arc} label="PayGate on Arc" className="size-20 border-primary/30 sm:size-24">
        <LogoMark full className="size-14 sm:size-16" />
      </Node>
      <Node ref={api} label="Your API">
        <Server className="size-7 text-foreground sm:size-8" />
      </Node>
      <AnimatedBeam containerRef={box} fromRef={agent} toRef={arc} curvature={-50} gradientStartColor="#2f80d8" gradientStopColor="#8b5cf6" duration={4} />
      <AnimatedBeam containerRef={box} fromRef={arc} toRef={api} curvature={-50} gradientStartColor="#8b5cf6" gradientStopColor="#2f80d8" duration={4} delay={1} />
      <AnimatedBeam containerRef={box} fromRef={agent} toRef={api} curvature={60} gradientStartColor="#22c55e" gradientStopColor="#2f80d8" duration={4} delay={2} reverse />
      <span className="absolute top-4 left-[28%] -translate-x-1/2 rounded-full border bg-background px-2 py-0.5 font-mono text-[10px] sm:text-[11px]">pay()</span>
      <span className="absolute top-4 left-[72%] -translate-x-1/2 rounded-full border bg-background px-2 py-0.5 font-mono text-[10px] sm:text-[11px]">hasAccess</span>
      <span className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 font-mono text-[10px] sm:text-[11px]">
        <Http code={402} /> → <Http code={200} />
      </span>
    </div>
  );
}

const STEPS = [
  { n: "01", icon: Server, title: "Ask", text: "An unpaid call gets HTTP 402 with the price." },
  { n: "02", icon: Coins, title: "Pay once", text: "One pay() on Arc. Gas is USDC too." },
  { n: "03", icon: Fingerprint, title: "Prove", text: "Sign, retry, get 200 until the pass ends." },
];

const WHY = [
  { icon: Coins, stat: "1 asset", title: "USDC is the gas", text: "Agents hold one balance. Nothing else to buy or bridge." },
  { icon: Layers, stat: "1 tx", title: "No approvals", text: "pay() is payable. No approve-then-transfer." },
  { icon: Zap, stat: "<$0.01", title: "Gas per pass", text: "About 61k gas at Arc's 20 gwei floor." },
  { icon: Landmark, stat: "0 fees", title: "No middleman", text: "No owner, no cut, no upgrade key." },
];

const AGENT_POINTS: [typeof ShieldCheck, string][] = [
  [ShieldCheck, "Pins the contract and re-checks the price on-chain"],
  [Coins, "Caps what it will spend"],
  [Fingerprint, "Never signs text the server sends"],
];

export function Home() {
  const { net, wallet } = useApp();
  const { resolvedTheme } = useTheme();
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
  const stats: [string, number | null, number, string][] = [
    ["Listings", ready ? list.length : null, 0, ""],
    ["Passes sold", ready ? Number(sold) : null, 0, ""],
    ["USDC settled", ready ? usdcNum(settled) : null, 3, "$"],
    ["Gas per pass", gasPerPass ? usdcNum(gasPerPass) : null, 4, "$"],
  ];

  return (
    <>
      {/* hero */}
      <section className="relative isolate overflow-hidden">
        <AnimatedGridPattern
          numSquares={28}
          maxOpacity={0.14}
          duration={3}
          className="absolute inset-0 -z-10 h-full w-full skew-y-6 fill-primary/25 stroke-primary/10 [mask-image:radial-gradient(640px_circle_at_center,white,transparent)]"
        />
        <div className="pointer-events-none absolute -top-48 left-1/2 -z-10 h-[520px] w-[960px] -translate-x-1/2 rounded-full bg-gradient-to-r from-primary/25 via-brand-2/15 to-transparent blur-3xl" />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-14 pb-16 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:pt-24 lg:pb-24">
          <div>
            <BlurFade delay={0.05}>
              <a
                href="#/agents"
                className="group relative inline-flex items-center rounded-full bg-background/60 px-4 py-1.5 shadow-[inset_0_-8px_10px_#8fbfff1f] backdrop-blur transition-shadow duration-500 hover:shadow-[inset_0_-5px_10px_#8fbfff3f]"
              >
                <span
                  aria-hidden="true"
                  className="animate-gradient absolute inset-0 block rounded-[inherit] bg-gradient-to-r from-[#2f80d8]/60 via-[#8b5cf6]/60 to-[#2f80d8]/60 bg-[length:300%_100%] p-px"
                  style={{
                    WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
                    WebkitMaskComposite: "destination-out",
                    mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
                    maskComposite: "subtract",
                  }}
                />
                <Sparkles className="size-3.5 text-primary" />
                <hr className="mx-2 h-4 w-px shrink-0 border-0 bg-border" />
                <AnimatedGradientText colorFrom="#2f80d8" colorTo="#8b5cf6" className="text-xs font-medium">
                  Native USDC payments on Arc
                </AnimatedGradientText>
                <ArrowRight className="ml-1.5 size-3 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </a>
            </BlurFade>
            <BlurFade delay={0.12}>
              <h1 className="mt-6 text-5xl leading-[1.02] font-semibold tracking-tighter text-balance sm:text-6xl lg:text-7xl">
                Paywall any API.{" "}
                <span className="bg-gradient-to-r from-[#2f80d8] via-[#5b6cf0] to-[#8b5cf6] bg-clip-text text-transparent">Get paid in USDC.</span>
              </h1>
            </BlurFade>
            <BlurFade delay={0.2}>
              <p className="mt-6 max-w-lg text-lg text-muted-foreground">One transaction to buy. No approvals, no gas token, no middleman. Built for AI agents.</p>
            </BlurFade>
            <BlurFade delay={0.28}>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <a href={featured ? `#/r/${featured.id}` : "#/market"}>
                  <ShimmerButton className="h-11 px-6 text-sm font-medium" background="linear-gradient(135deg,#2f80d8,#1e4f9a)">
                    {featured ? "Try a pass" : "Browse the market"}
                    <ArrowRight className="ml-2 size-4" />
                  </ShimmerButton>
                </a>
                <Button asChild variant="outline" size="lg" className="h-11 rounded-full bg-background/60 px-6 backdrop-blur">
                  <a href="#/sell">List your API</a>
                </Button>
              </div>
            </BlurFade>
          </div>

          <BlurFade delay={0.25} className="space-y-5">
            {net.contract ? (
              res.loading && !res.data ? (
                <Skeleton className="h-44 rounded-2xl" />
              ) : featured ? (
                <a href={`#/r/${featured.id}`} className="block transition-transform duration-300 hover:-translate-y-1">
                  <Pass r={featured} until={access.until} holder={wallet?.address} />
                </a>
              ) : (
                <Pass r={SAMPLE} until={0} preview />
              )
            ) : (
              <>
                <Pass r={SAMPLE} until={0} preview />
                <NotDeployed />
              </>
            )}
            {net.contract && <LiveFeed resources={list} />}
          </BlurFade>
        </div>
      </section>

      {/* listings marquee */}
      {ready && list.length > 0 && (
        <section className="relative border-y bg-muted/30 py-4">
          <Marquee pauseOnHover className="[--duration:40s] [--gap:0.75rem]">
            {list.map((r) => (
              <a key={r.id.toString()} href={`#/r/${r.id}`} className="flex items-center gap-2 rounded-full border bg-card px-4 py-1.5 text-sm whitespace-nowrap transition-colors hover:border-primary/40">
                <span className="font-medium">{r.meta.name}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {usdc(r.price)} / {perWindow(r.window)}
                </span>
              </a>
            ))}
          </Marquee>
          <div className="pointer-events-none absolute inset-y-0 left-0 w-24 bg-gradient-to-r from-background" />
          <div className="pointer-events-none absolute inset-y-0 right-0 w-24 bg-gradient-to-l from-background" />
        </section>
      )}

      {/* stats */}
      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border bg-border lg:grid-cols-4">
          {stats.map(([label, v, dp, pre]) => (
            <div key={label} className="bg-card p-5 sm:p-6">
              <Eyebrow>{label}</Eyebrow>
              <div className="mt-2 font-mono text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">
                {v === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <>
                    {pre}
                    <NumberTicker value={v} decimalPlaces={dp} className="tracking-tight" />
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* how it works */}
      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <BlurFade inView>
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <Eyebrow>How it works</Eyebrow>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">402 to 200 in one payment</h2>
          </div>
        </BlurFade>
        <BlurFade inView delay={0.1}>
          <FlowDiagram />
        </BlurFade>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <BlurFade key={s.n} inView delay={0.1 + i * 0.08}>
              <div className="flex h-full gap-4 rounded-2xl border bg-card p-5">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                  <s.icon className="size-5" />
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{s.n}</span>
                    <h3 className="font-semibold">{s.title}</h3>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{s.text}</p>
                </div>
              </div>
            </BlurFade>
          ))}
        </div>
      </section>

      {/* why arc */}
      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <BlurFade inView>
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <Eyebrow>Why Arc</Eyebrow>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Paying for an API should be one step</h2>
          </div>
        </BlurFade>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {WHY.map((w, i) => (
            <BlurFade key={w.title} inView delay={i * 0.07} className="h-full">
              <MagicCard className="h-full rounded-2xl" gradientColor={resolvedTheme === "dark" ? "#1c2740" : "#e6effb"} gradientFrom="#2f80d8" gradientTo="#8b5cf6">
                <div className="p-4 sm:p-6">
                  <w.icon className="size-5 text-primary" />
                  <div className="mt-4 text-2xl font-semibold tracking-tight sm:mt-6 sm:text-3xl">{w.stat}</div>
                  <div className="mt-1 text-sm font-medium sm:text-base">{w.title}</div>
                  <p className="mt-2 hidden text-sm text-muted-foreground sm:block">{w.text}</p>
                </div>
              </MagicCard>
            </BlurFade>
          ))}
        </div>
      </section>

      {/* agents */}
      <section className="mx-auto max-w-6xl px-4 py-14 pb-24 sm:px-6">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <BlurFade inView>
            <Eyebrow>For agents</Eyebrow>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Buy access from a script</h2>
            <ul className="mt-6 space-y-3">
              {AGENT_POINTS.map(([Icon, t]) => (
                <li key={t} className="flex items-center gap-3 text-sm">
                  <span className="grid size-7 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="size-4" />
                  </span>
                  {t}
                </li>
              ))}
            </ul>
            <Button asChild variant="outline" className="mt-8 rounded-full">
              <a href="#/agents">
                Integration guide <ArrowRight className="size-4" />
              </a>
            </Button>
          </BlurFade>
          <BlurFade inView delay={0.1}>
            <CodeTabs
              tabs={[
                {
                  key: "py",
                  label: "Python",
                  plain: `pip install web3 eth-account httpx\nexport EVM_PRIVATE_KEY=0x…\npython py/client.py fetch \\\n  https://api.example.com/api/data \\\n  --contract ${contract} \\\n  --max-usdc 0.05`,
                  rich: (
                    <>
                      <span className={tok.c}>{"# pip install web3 eth-account httpx\n"}</span>
                      <span className={tok.k}>export</span>
                      {" EVM_PRIVATE_KEY=0x…\n"}
                      {"python py/client.py "}
                      <span className={tok.f}>fetch</span>
                      {" \\\n  "}
                      <span className={tok.s}>https://api.example.com/api/data</span>
                      {" \\\n  --contract "}
                      <span className={tok.s}>{contract}</span>
                      {" \\\n  --max-usdc "}
                      <span className={tok.n}>0.05</span>
                    </>
                  ),
                },
                {
                  key: "sol",
                  label: "Contract",
                  plain: `function quote(uint256 id) view returns (uint96 price, uint32 window, address seller, bool active, string uri);\nfunction pay(uint256 id, uint32 minWindow) payable returns (uint64 until);\nfunction hasAccess(address who, uint256 id) view returns (bool);`,
                  rich: (
                    <>
                      <span className={tok.k}>function</span> <span className={tok.f}>quote</span>(uint256 id) <span className={tok.k}>view returns</span> (uint96 price, uint32 window, …){"\n"}
                      <span className={tok.k}>function</span> <span className={tok.f}>pay</span>(uint256 id, uint32 minWindow) <span className={tok.k}>payable returns</span> (uint64 until){"\n"}
                      <span className={tok.k}>function</span> <span className={tok.f}>hasAccess</span>(address who, uint256 id) <span className={tok.k}>view returns</span> (bool)
                    </>
                  ),
                },
              ]}
            />
          </BlurFade>
        </div>
      </section>
    </>
  );
}
