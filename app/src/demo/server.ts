/**
 * A seller server for the Demo network, run in the page. It applies the same rules as py/server.py:
 * recover the signer of the host-bound PayGate message (current or previous five-minute bucket), check
 * hasAccess on the contract, and answer 402 or 200 with sample data.
 */
import { recoverMessageAddress, type Hex, type PublicClient } from "viem";
import { payGateAbi } from "../abi";
import { authMessage, NONCE_PERIOD } from "../lib/auth";
import { parseMeta } from "../lib/meta";
import { usdc } from "../lib/format";
import { DEMO_CHAIN_ID, DEMO_CONTRACT } from "./index";

function sample(path: string, now: number) {
  const t = new Date(now * 1000).toISOString();
  if (path.includes("polymarket-rewards"))
    return {
      updated: t,
      markets: [
        { market: "Fed cuts rates in December?", reward_usdc_per_day: 450, min_size: 200, max_spread_cents: 3.5 },
        { market: "BTC above $150k on Dec 31?", reward_usdc_per_day: 300, min_size: 100, max_spread_cents: 3 },
        { market: "Arc mainnet TVL above $1B by Q1?", reward_usdc_per_day: 120, min_size: 50, max_spread_cents: 4.5 },
      ],
    };
  if (path.includes("btc-5m-replay"))
    return { day: t.slice(0, 10), files: [{ name: `btc-updown-5m-${t.slice(0, 10).replaceAll("-", "")}.jsonl.gz`, rows: 1_284_311, bytes: 46_661_110 }] };
  if (path.includes("arc-gas")) return { block: 25_642_553 + Math.floor(now / 2) % 1000, base_fee_gwei: 20, forecast_5m_gwei: 20, updated: t };
  if (path.includes("search")) return { query: "x402 agent payments", results: [{ rank: 1, title: "HTTP 402 Payment Required", url: "https://developer.mozilla.org/docs/Web/HTTP/Status/402" }] };
  return { ok: true, updated: t };
}

export async function demoFetch(pub: PublicClient, url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  const host = u.host.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const all = await pub.readContract({ address: DEMO_CONTRACT, abi: payGateAbi, functionName: "getResources", args: [1n, 25n] });
  const r = all.find((x) => {
    const m = parseMeta(x.uri, x.id);
    return m.host?.toLowerCase() === host && m.path === u.pathname + u.search;
  });
  if (!r) return { status: 404, body: JSON.stringify({ error: "NOT_FOUND" }) };

  const nonce = Math.floor(now / NONCE_PERIOD);
  const offer = {
    x402Version: 1,
    error: "PAYMENT_REQUIRED",
    scheme: "paygate-native-v2",
    chain_id: DEMO_CHAIN_ID,
    contract: DEMO_CONTRACT,
    resource_id: Number(r.id),
    price_usdc: usdc(r.price),
    window_seconds: r.window,
    auth: { nonce, host, message: authMessage(DEMO_CHAIN_ID, DEMO_CONTRACT, r.id, nonce, host) },
  };
  const addr = headers["X-PayGate-Address"];
  const sig = headers["X-PayGate-Signature"] as Hex | undefined;
  if (!addr || !sig) return { status: 402, body: JSON.stringify(offer) };

  let signer: string | null = null;
  for (const n of [nonce, nonce - 1]) {
    try {
      const who = await recoverMessageAddress({ message: authMessage(DEMO_CHAIN_ID, DEMO_CONTRACT, r.id, n, host), signature: sig });
      if (who.toLowerCase() === addr.toLowerCase()) signer = who;
    } catch {
      /* malformed signature */
    }
    if (signer) break;
  }
  if (!signer) return { status: 401, body: JSON.stringify({ error: "BAD_SIGNATURE", detail: "Signature does not match X-PayGate-Address for this host and time bucket." }) };

  const [ok, until] = await Promise.all([
    pub.readContract({ address: DEMO_CONTRACT, abi: payGateAbi, functionName: "hasAccess", args: [signer as Hex, r.id] }),
    pub.readContract({ address: DEMO_CONTRACT, abi: payGateAbi, functionName: "accessUntil", args: [signer as Hex, r.id] }),
  ]);
  if (!ok) return { status: 402, body: JSON.stringify({ ...offer, detail: "No active pass for this address." }) };
  return { status: 200, body: JSON.stringify({ resource: parseMeta(r.uri, r.id).name, access_until: Number(until), data: sample(u.pathname, now) }) };
}
