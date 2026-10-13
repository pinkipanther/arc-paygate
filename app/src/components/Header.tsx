import { motion } from "motion/react";
import { Check, ChevronDown, LogOut, Monitor, Moon, Sun, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text";
import { cn } from "@/lib/utils";
import { useTheme, type Theme } from "@/lib/theme";
import { NETWORKS, NET_KEYS } from "../config";
import { short, usdc } from "../lib/format";
import { useChainInfo, useWalletBalance } from "../lib/hooks";
import { useApp } from "../lib/store";
import { Wordmark } from "./brand";
import { CopyButton } from "./common";

export const NAV: [string, string][] = [
  ["#/", "Home"],
  ["#/market", "Market"],
  ["#/sell", "Sell"],
  ["#/activity", "Activity"],
  ["#/agents", "Agents"],
];

function isCurrent(href: string, route: string) {
  const r = route || "#/";
  if (href === "#/") return r === "#/" || r === "#" || r === "";
  return r.startsWith(href) || (href === "#/market" && r.startsWith("#/r/"));
}

function Dot({ tone }: { tone: "ok" | "warn" | "bad" | "idle" }) {
  return (
    <span
      className={cn(
        "size-2 rounded-full",
        tone === "ok" && "bg-success shadow-[0_0_0_3px] shadow-success/20",
        tone === "warn" && "bg-warning",
        tone === "bad" && "bg-destructive",
        tone === "idle" && "bg-muted-foreground/40",
      )}
    />
  );
}

function NetworkMenu() {
  const { netKey, net, setNet } = useApp();
  const info = useChainInfo();
  const tone = !info.ok ? (info.block === null ? "idle" : "bad") : net.contract ? "ok" : "warn";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-2 rounded-full px-3">
          <Dot tone={tone} />
          {net.short}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Network</DropdownMenuLabel>
        {NET_KEYS.map((k) => {
          const n = NETWORKS[k];
          return (
            <DropdownMenuItem key={k} onSelect={() => setNet(k)} className="gap-3 py-2">
              <Dot tone={n.contract ? "ok" : "idle"} />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{n.label}</div>
                <div className="text-xs text-muted-foreground">{n.simulated ? "In your browser · no wallet" : n.contract ? `Live · chain ${n.chain.id}` : "Not deployed yet"}</div>
              </div>
              {k === netKey && <Check className="size-4 text-primary" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
          {info.block ? `block ${info.block.toLocaleString()}${info.gasPrice ? ` · ${(Number(info.gasPrice) / 1e9).toFixed(0)} gwei` : ""}` : "connecting…"}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const opts: [Theme, string, typeof Sun][] = [
    ["light", "Light", Sun],
    ["dark", "Dark", Moon],
    ["system", "System", Monitor],
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-9 rounded-full" aria-label="Theme">
          {resolvedTheme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {opts.map(([k, l, I]) => (
          <DropdownMenuItem key={k} onSelect={() => setTheme(k)} className="gap-2">
            <I className="size-4" /> {l}
            {theme === k && <Check className="ml-auto size-4 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WalletButton() {
  const { wallet, net, openWallet, disconnect } = useApp();
  const bal = useWalletBalance(wallet?.address);
  if (!wallet)
    return (
      <Button size="sm" className="h-9 rounded-full px-4" onClick={() => openWallet(true)}>
        <Wallet className="size-4" />
        Connect
      </Button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-2 rounded-full pr-3 pl-1.5">
          {wallet.icon ? (
            <img src={wallet.icon} alt="" className="size-6 rounded-full" />
          ) : (
            <span className="grid size-6 place-items-center rounded-full bg-gradient-to-br from-primary to-brand-2 text-white">
              <Wallet className="size-3.5" />
            </span>
          )}
          <span className="font-mono text-xs">{short(wallet.address, 5, 4)}</span>
          {bal !== null && <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{usdc(bal, 2)}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <div className="space-y-2 p-2">
          <div className="text-xs text-muted-foreground">{wallet.name}</div>
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{wallet.address}</span>
            <CopyButton text={wallet.address} label="Copy address" />
          </div>
          <div className="text-2xl font-semibold tracking-tight">
            {bal === null ? "…" : usdc(bal)} <span className="text-sm font-normal text-muted-foreground">USDC</span>
          </div>
          {net.simulated && <p className="text-xs text-muted-foreground">Throwaway demo key. Resets on reload.</p>}
        </div>
        {!net.simulated && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={disconnect} className="gap-2">
              <LogOut className="size-4" /> Disconnect
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavLinks({ route, compact }: { route: string; compact?: boolean }) {
  return (
    <nav className={cn("flex items-center", compact ? "gap-1 overflow-x-auto [scrollbar-width:none]" : "gap-0.5")} aria-label="Main">
      {NAV.map(([href, label]) => {
        const on = isCurrent(href, route);
        return (
          <a
            key={href}
            href={href}
            aria-current={on ? "page" : undefined}
            className={cn(
              "relative rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
              compact && "flex-1 px-2 text-center",
              on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {on && (
              <motion.span
                layoutId={compact ? "nav-pill-m" : "nav-pill"}
                className="absolute inset-0 -z-10 rounded-full bg-muted"
                transition={{ type: "spring", bounce: 0.2, duration: 0.5 }}
              />
            )}
            {label}
          </a>
        );
      })}
    </nav>
  );
}

export function Header({ route }: { route: string }) {
  const { net, setNet } = useApp();
  const live = (["testnet", "mainnet"] as const).find((k) => NETWORKS[k].contract);
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <a href="#/" aria-label="PayGate home" className="shrink-0">
          <Wordmark className="[&>span:last-child]:max-[400px]:hidden" />
        </a>
        <div className="hidden md:block">
          <NavLinks route={route} />
        </div>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <NetworkMenu />
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-3 pb-2 md:hidden">
        <NavLinks route={route} compact />
      </div>
      {net.simulated && (
        <div className="border-t border-border/60 bg-primary/[0.06]">
          <div className="mx-auto flex max-w-6xl items-center justify-center gap-2 px-4 py-1.5 text-center text-xs sm:px-6">
            <span className="rounded bg-primary px-1.5 py-px font-mono text-[10px] font-semibold uppercase tracking-wider text-primary-foreground">Demo</span>
            <AnimatedShinyText className="mx-0 max-w-none truncate text-xs">
              Real contract, in your browser<span className="hidden sm:inline"> · 25 test USDC to play with</span>
            </AnimatedShinyText>
            {live && (
              <button type="button" onClick={() => setNet(live)} className="ml-1 font-medium text-primary hover:underline">
                Use {NETWORKS[live].short} →
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
