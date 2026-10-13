import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Lock, PenLine, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useApp } from "../lib/store";
import { useNow, type Resource } from "../lib/hooks";
import { explain } from "../lib/tx";
import { authMessage, NONCE_PERIOD } from "../lib/auth";
import { demoFetch } from "../demo/server";
import { CodeTabs } from "./CodeTabs";
import { CopyButton, Http, Spinner } from "./common";

interface Signed {
  address: string;
  signature: string;
  message: string;
  nonce: number;
  url: string;
}

interface Result {
  status: number;
  body: string;
  ms: number;
}

/** Proves the pass to the seller's server: sign the PayGate message, then call the endpoint with it. */
export function UsePass({ r, held }: { r: Resource; held: boolean }) {
  const { wallet, net, pub, signer, openWallet } = useApp();
  const now = useNow();
  const [signed, setSigned] = useState<Signed | null>(null);
  const [busy, setBusy] = useState<"sign" | "send" | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const url = r.meta.url;

  if (!url) return <p className="text-sm text-muted-foreground">No endpoint listed. Servers can still check this pass with hasAccess().</p>;
  if (!held)
    return (
      <div className="flex items-center gap-3 rounded-xl border border-dashed p-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Lock className="size-4" />
        </span>
        <p className="text-sm text-muted-foreground">
          Buy a pass to turn <Http code={402} /> into <Http code={200} /> right here.
        </p>
      </div>
    );

  const stale = signed && Math.floor(now / NONCE_PERIOD) - signed.nonce > 1;

  async function sign() {
    if (!wallet) return openWallet(true);
    setErr(null);
    setRes(null);
    setBusy("sign");
    try {
      const host = new URL(url!).host;
      const nonce = Math.floor(Date.now() / 1000 / NONCE_PERIOD);
      const message = authMessage(net.chain.id, net.contract!, r.id, nonce, host);
      const wc = await signer();
      const signature = await wc.signMessage({ account: wc.account ?? wallet.address, message });
      setSigned({ address: wallet.address, signature, message, nonce, url: url! });
    } catch (e) {
      setErr(explain(e));
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    if (!signed) return;
    setBusy("send");
    setErr(null);
    const t0 = performance.now();
    try {
      const headers = { "X-PayGate-Address": signed.address, "X-PayGate-Signature": signed.signature };
      // On the Demo network the seller's server runs in the page too (src/demo/server.ts).
      const resp = net.simulated
        ? await demoFetch(pub, signed.url, headers)
        : await fetch(signed.url, { headers, cache: "no-store" }).then(async (x) => ({ status: x.status, body: await x.text() }));
      let body = resp.body;
      try {
        body = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        /* not json */
      }
      setRes({ status: resp.status, body: body.length > 6000 ? body.slice(0, 6000) + "\n…" : body, ms: Math.round(performance.now() - t0) });
    } catch {
      setErr(`${new URL(signed.url).host} didn't answer from the browser. Try the curl command.`);
    } finally {
      setBusy(null);
    }
  }

  const curl = signed ? `curl ${signed.url} \\\n  -H "X-PayGate-Address: ${signed.address}" \\\n  -H "X-PayGate-Signature: ${signed.signature}"` : "";
  const step = res ? 3 : signed && !stale ? 2 : 1;

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <Button variant={step === 1 ? "default" : "outline"} onClick={sign} disabled={busy !== null} className="h-11 justify-start rounded-xl">
          {busy === "sign" ? <Spinner /> : <PenLine className="size-4" />}
          <span className="font-mono text-xs opacity-60">1</span> {signed && !stale ? "Sign again" : "Sign request"}
        </Button>
        <Button variant={step === 2 ? "default" : "outline"} onClick={send} disabled={!signed || !!stale || busy !== null} className="h-11 justify-start rounded-xl">
          {busy === "send" ? <Spinner /> : <Send className="size-4" />}
          <span className="font-mono text-xs opacity-60">2</span> Call the API
        </Button>
      </div>
      {stale && <p className="text-xs text-warning">Signature expired. Sign again.</p>}
      {err && <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{err}</p>}

      <AnimatePresence>
        {signed && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={signed.message}>
                {signed.message}
              </span>
              <CopyButton text={signed.message} label="Copy signed message" />
            </div>
            <CodeTabs tabs={[{ key: "curl", label: "curl", plain: curl }]} title="same request from a terminal" />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {res && (
          <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className={cn("overflow-hidden rounded-xl border", res.status === 200 ? "border-success/40" : "border-warning/40")}>
            <div className={cn("flex items-center gap-2 px-3 py-2 text-xs", res.status === 200 ? "bg-success/10" : "bg-warning/10")}>
              <Http code={res.status} />
              <span className="text-muted-foreground">
                {res.ms} ms · {new URL(signed!.url).host}
              </span>
            </div>
            <pre className="max-h-80 overflow-auto bg-[#0b0f17] p-4 font-mono text-[12px] leading-relaxed text-[#d6deeb]">{res.body || "(empty body)"}</pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
