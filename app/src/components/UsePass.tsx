import { useState } from "react";
import { useApp } from "../lib/store";
import { useNow, type Resource } from "../lib/hooks";
import { explain } from "../lib/tx";
import { CopyButton, Spinner } from "./ui";
import { Lock } from "./icons";

const NONCE_PERIOD = 300;

/** Must match py/server.py exactly; see /.well-known/paygate.json → message_format. */
export function authMessage(chainId: number, contract: string, rid: bigint, nonce: number, host: string): string {
  return `paygate:2:${chainId}:${contract.toLowerCase()}:${rid}:${nonce}:${host.toLowerCase()}`;
}

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
  const { wallet, net, signer, openWallet } = useApp();
  const now = useNow();
  const [signed, setSigned] = useState<Signed | null>(null);
  const [busy, setBusy] = useState<"sign" | "send" | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const url = r.meta.url;

  if (!url) {
    return <p className="muted">This listing has no endpoint URL, so there is nothing to call. The pass still exists on-chain and any server can check it with hasAccess().</p>;
  }
  if (!held) {
    return (
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <span className="iconbtn" style={{ background: "var(--surface-2)" }}>
          <Lock />
        </span>
        <p className="muted" style={{ flex: 1, minWidth: 0 }}>
          Calling <span className="mono ink2">{r.meta.host}</span> without a pass returns <span className="http s402">402</span>. Buy a pass and this panel signs a request with your wallet and sends it, so you can watch the server turn it into a <span className="http s200">200</span>.
        </p>
      </div>
    );
  }

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
      const resp = await fetch(signed.url, {
        headers: { "X-PayGate-Address": signed.address, "X-PayGate-Signature": signed.signature },
        cache: "no-store",
      });
      let body = await resp.text();
      try {
        body = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        /* not json */
      }
      setRes({ status: resp.status, body: body.length > 6000 ? body.slice(0, 6000) + "\n…" : body, ms: Math.round(performance.now() - t0) });
    } catch {
      setErr(`${new URL(signed.url).host} did not answer from this browser. The server may be offline or not allow cross-origin requests; the curl command below works from any terminal.`);
    } finally {
      setBusy(null);
    }
  }

  const curl = signed
    ? `curl ${signed.url} \\\n  -H "X-PayGate-Address: ${signed.address}" \\\n  -H "X-PayGate-Signature: ${signed.signature}"`
    : "";

  return (
    <div className="stack" style={{ gap: 14 }}>
      <p className="ink2" style={{ fontSize: "0.93rem" }}>
        Your wallet signs a short message bound to this chain, contract, resource and host. The signature is a bearer credential for about five minutes; it moves no funds.
      </p>
      <div className="row">
        <button className="btn btn-primary" onClick={sign} disabled={busy !== null}>
          {busy === "sign" && <Spinner />}
          {signed && !stale ? "Sign again" : "Sign request"}
        </button>
        <button className="btn btn-secondary" onClick={send} disabled={!signed || !!stale || busy !== null}>
          {busy === "send" && <Spinner />}
          Send to {r.meta.host}
        </button>
        {stale && <span className="pill warn">Signature expired, sign again</span>}
      </div>
      {err && (
        <div className="banner" style={{ fontSize: "0.86rem" }}>
          {err}
        </div>
      )}
      {signed && (
        <div>
          <div className="spread" style={{ marginBottom: 6 }}>
            <span className="label">Signed message</span>
            <CopyButton text={signed.message} />
          </div>
          <div className="mono" style={{ fontSize: "0.8rem", padding: "10px 12px", background: "var(--surface-2)", borderRadius: 10, overflowWrap: "anywhere" }}>
            {signed.message}
          </div>
          <div className="spread" style={{ margin: "14px 0 6px" }}>
            <span className="label">Same request from a terminal</span>
            <CopyButton text={curl} />
          </div>
          <pre className="code">{curl}</pre>
        </div>
      )}
      {res && (
        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className={`http ${res.status === 200 ? "s200" : "s402"}`}>{res.status}</span>
            <span className="muted" style={{ fontSize: "0.84rem" }}>
              {res.ms} ms from {new URL(signed!.url).host}
            </span>
          </div>
          <pre className="code" style={{ maxHeight: 360, overflow: "auto" }}>
            {res.body || "(empty body)"}
          </pre>
        </div>
      )}
    </div>
  );
}
