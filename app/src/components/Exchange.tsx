import { useEffect, useRef, useState, type ReactNode } from "react";

const ROWS: { dir: string; line: string; note: string; tag: ReactNode; chain?: boolean }[] = [
  { dir: "agent", line: "GET /api/polymarket-rewards", note: "No credentials yet.", tag: null },
  {
    dir: "server",
    line: "402 Payment Required",
    note: "chain 5042 · contract 0x…c0de · resource 1 · 0.01 USDC · 3600 s",
    tag: <span className="http s402">402</span>,
  },
  { dir: "agent", line: "quote(1) → 0.01 USDC, 3600 s", note: "Re-reads the terms on-chain; never trusts the 402 body.", tag: null },
  {
    dir: "arc",
    line: "pay(1, 3600)  value: 0.01 USDC",
    note: "One transaction. Gas is paid in the same USDC, a fraction of a cent.",
    tag: <span className="pill blue">1 tx</span>,
    chain: true,
  },
  { dir: "agent", line: "GET /api/polymarket-rewards", note: "X-PayGate-Address + a signature bound to chain, contract, resource and host.", tag: null },
  { dir: "server", line: "200 OK", note: "hasAccess(agent, 1) is true until the window ends.", tag: <span className="http s200">200</span> },
];

/** A six-line HTTP/chain transcript that steps through once when it scrolls into view. */
export function Exchange() {
  const ref = useRef<HTMLDivElement>(null);
  const [lit, setLit] = useState(ROWS.length);
  const [play, setPlay] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    let timers: number[] = [];
    const io = new IntersectionObserver(
      (es) => {
        if (!es[0].isIntersecting) return;
        io.disconnect();
        setPlay(true);
        setLit(0);
        timers = ROWS.map((_, i) => window.setTimeout(() => setLit(i + 1), 450 + i * 650));
        timers.push(window.setTimeout(() => setPlay(false), 450 + ROWS.length * 650 + 300));
      },
      { threshold: 0.45 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
    };
  }, []);

  return (
    <div className="exchange" ref={ref} data-play={play}>
      {ROWS.map((r, i) => (
        <div key={i} className={`ex-row ${r.chain ? "chain" : ""} ${i < lit ? "lit" : ""}`}>
          <span className="dir">{r.dir}</span>
          <div className="line">
            {r.line}
            <small>{r.note}</small>
          </div>
          <span className="tag">{r.tag}</span>
        </div>
      ))}
    </div>
  );
}
