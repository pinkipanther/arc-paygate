import { useEffect, useState } from "react";
import { Header } from "./components/Header";
import { Toasts } from "./components/Toasts";
import { WalletModal } from "./components/WalletModal";
import { Box } from "./components/icons";
import { Empty } from "./components/ui";
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
        <div className="wrap">
          <div className="card">
            <Empty icon={<Box />} title="That page doesn't exist" action={<a className="btn btn-secondary" href="#/">Go to the overview</a>} />
          </div>
        </div>
      );
  }
}

export function App() {
  const h = useHash();
  const { net } = useApp();
  return (
    <>
      <Header route={h} />
      <main key={net.key}>{route(h)}</main>
      <footer className="site">
        <div className="wrap spread">
          <div className="row">
            <span>PayGate · MIT</span>
            <a href={REPO} target="_blank" rel="noopener noreferrer">
              Source &amp; audit
            </a>
            <a href="#/agents">Integration guide</a>
            {net.explorer && net.contract && (
              <a href={`${net.explorer}/address/${net.contract}`} target="_blank" rel="noopener noreferrer">
                Contract on {net.short}
              </a>
            )}
          </div>
          <span>Payments settle in native USDC on Arc. No owner, no fees.</span>
        </div>
      </footer>
      <WalletModal />
      <Toasts />
    </>
  );
}
