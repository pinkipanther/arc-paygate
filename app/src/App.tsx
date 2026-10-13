import { useEffect, useState } from "react";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { Wordmark } from "./components/brand";
import { Empty, ExtLink } from "./components/common";
import { Header } from "./components/Header";
import { WalletModal } from "./components/WalletModal";
import { REPO } from "./config";
import { useApp } from "./lib/store";
import { Activity } from "./pages/Activity";
import { Agents } from "./pages/Agents";
import { Home } from "./pages/Home";
import { Market } from "./pages/Market";
import { ResourcePage } from "./pages/ResourcePage";
import { Sell } from "./pages/Sell";

function useHash(): string {
  const [h, setH] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const on = () => {
      setH(window.location.hash || "#/");
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return h;
}

function route(h: string) {
  const path = h.replace(/^#/, "") || "/";
  const m = path.match(/^\/r\/(\d+)\/?$/);
  if (m) return <ResourcePage id={BigInt(m[1])} />;
  switch (path.replace(/\/$/, "") || "/") {
    case "/":
      return <Home />;
    case "/market":
      return <Market />;
    case "/sell":
      return <Sell />;
    case "/activity":
      return <Activity />;
    case "/agents":
      return <Agents />;
    default:
      return (
        <div className="mx-auto max-w-6xl px-4 py-16">
          <Empty
            icon={<Compass />}
            title="Page not found"
            action={
              <Button asChild variant="outline" className="rounded-full">
                <a href="#/">Go home</a>
              </Button>
            }
          />
        </div>
      );
  }
}

const TITLES: Record<string, string> = { "/market": "Market", "/sell": "Sell", "/activity": "Activity", "/agents": "Integrate" };

export function App() {
  const h = useHash();
  const { net } = useApp();
  useEffect(() => {
    const path = h.replace(/^#/, "").replace(/\/$/, "");
    if (/^\/r\/\d+$/.test(path)) return; // the resource page names itself once it loads
    document.title = TITLES[path] ? `${TITLES[path]} · PayGate` : "PayGate";
  }, [h]);
  return (
    <div className="flex min-h-svh flex-col">
      <Header route={h} />
      <main key={net.key} className="flex-1">
        {route(h)}
      </main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 sm:px-6">
          <div className="flex items-center gap-4">
            <Wordmark className="text-sm [&_svg]:size-6" />
            <span className="text-xs text-muted-foreground">MIT · no owner · no fees</span>
          </div>
          <div className="flex items-center gap-5">
            <a href="#/agents" className="text-sm text-muted-foreground hover:text-foreground">
              Docs
            </a>
            <ExtLink href={REPO}>GitHub</ExtLink>
            {net.explorer && net.contract && <ExtLink href={`${net.explorer}/address/${net.contract}`}>Contract</ExtLink>}
          </div>
        </div>
      </footer>
      <WalletModal />
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}
