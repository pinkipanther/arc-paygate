import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Log } from "viem";
import { payGateAbi } from "../abi";
import { useApp } from "./store";
import { parseMeta, type Meta } from "./meta";

export interface Resource {
  id: bigint;
  seller: Address;
  price: bigint;
  window: number;
  active: boolean;
  sales: bigint;
  revenue: bigint;
  uri: string;
  meta: Meta;
}

export type Load<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void };

const PAGE = 25n; // a full 100-entry page can cost ~4M gas of cold reads; stay well under RPC caps

/** Ticks once a second for countdowns. */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function useChainInfo(): { block: bigint | null; gasPrice: bigint | null; ok: boolean } {
  const { pub, net } = useApp();
  const [s, setS] = useState<{ block: bigint | null; gasPrice: bigint | null; ok: boolean }>({ block: null, gasPrice: null, ok: false });
  useEffect(() => {
    let live = true;
    setS({ block: null, gasPrice: null, ok: false });
    const tick = async () => {
      try {
        const [block, gasPrice] = await Promise.all([pub.getBlockNumber({ cacheTime: 0 }), pub.getGasPrice()]);
        if (live) setS({ block, gasPrice, ok: true });
      } catch {
        if (live) setS((x) => ({ ...x, ok: false }));
      }
    };
    tick();
    const t = setInterval(tick, 6000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [pub, net.key]);
  return s;
}

function toResource(r: {
  id: bigint;
  seller: Address;
  price: bigint;
  window: number;
  active: boolean;
  sales: bigint;
  revenue: bigint;
  uri: string;
}): Resource {
  return { ...r, window: Number(r.window), meta: parseMeta(r.uri, r.id) };
}

export function useResources(): Load<Resource[]> {
  const { pub, net, version } = useApp();
  const [state, setState] = useState<{ data: Resource[] | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    const addr = net.contract;
    if (!addr) {
      setState({ data: [], error: null, loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    (async () => {
      try {
        const all: Resource[] = [];
        let from = 1n;
        for (let guard = 0; guard < 40; guard++) {
          const page = await pub.readContract({ address: addr, abi: payGateAbi, functionName: "getResources", args: [from, PAGE] });
          all.push(...page.map(toResource));
          if (BigInt(page.length) < PAGE) break;
          from += PAGE;
        }
        if (live) setState({ data: all, error: null, loading: false });
      } catch (e) {
        if (live) setState((s) => ({ data: s.data, error: (e as { shortMessage?: string }).shortMessage || (e as Error).message, loading: false }));
      }
    })();
    const t = setInterval(() => setNonce((n) => n + 1), 20_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [pub, net.contract, version, nonce]);

  return { ...state, reload };
}

export function useResource(id: bigint | null): Load<Resource> {
  const { pub, net, version } = useApp();
  const [state, setState] = useState<{ data: Resource | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    if (!net.contract || id === null) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    (async () => {
      try {
        const r = await pub.readContract({ address: net.contract!, abi: payGateAbi, functionName: "getResource", args: [id] });
        if (live) setState({ data: r.seller === "0x0000000000000000000000000000000000000000" ? null : toResource(r), error: null, loading: false });
      } catch (e) {
        if (live) setState({ data: null, error: (e as { shortMessage?: string }).shortMessage || (e as Error).message, loading: false });
      }
    })();
    const t = setInterval(() => setNonce((n) => n + 1), 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [pub, net.contract, id, version, nonce]);
  return { ...state, reload };
}

/** accessUntil for the connected wallet, or a chosen address. */
export function useAccess(id: bigint | null, who?: Address | null): { until: number; reload: () => void } {
  const { pub, net, wallet, version } = useApp();
  const holder = who ?? wallet?.address ?? null;
  const [until, setUntil] = useState(0);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    if (!net.contract || id === null || !holder) {
      setUntil(0);
      return;
    }
    pub
      .readContract({ address: net.contract, abi: payGateAbi, functionName: "accessUntil", args: [holder, id] })
      .then((u) => live && setUntil(Number(u)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [pub, net.contract, id, holder, version, nonce]);
  return { until, reload: () => setNonce((n) => n + 1) };
}

export function useBalance(who: Address | null | undefined): bigint | null {
  const { pub, net, version } = useApp();
  const [b, setB] = useState<bigint | null>(null);
  useEffect(() => {
    let live = true;
    if (!net.contract || !who) {
      setB(null);
      return;
    }
    pub
      .readContract({ address: net.contract, abi: payGateAbi, functionName: "balances", args: [who] })
      .then((v) => live && setB(v))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [pub, net.contract, who, version]);
  return b;
}

export function useWalletBalance(who: Address | null | undefined): bigint | null {
  const { pub, version } = useApp();
  const [b, setB] = useState<bigint | null>(null);
  useEffect(() => {
    let live = true;
    if (!who) {
      setB(null);
      return;
    }
    pub
      .getBalance({ address: who })
      .then((v) => live && setB(v))
      .catch(() => undefined);
    const t = setInterval(() => pub.getBalance({ address: who }).then((v) => live && setB(v)).catch(() => undefined), 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [pub, who, version]);
  return b;
}

export interface ActivityItem {
  kind: "Paid" | "ResourceCreated" | "ResourceUpdated" | "ResourceTransferred" | "Withdrawn";
  block: bigint;
  tx: `0x${string}`;
  logIndex: number;
  args: Record<string, unknown>;
  time: number | null;
}

/** Scans contract events from the deployment block in shrinking chunks (public RPCs cap log ranges). */
export function useActivity(limit = 60): Load<ActivityItem[]> {
  const { pub, net, version } = useApp();
  const [state, setState] = useState<{ data: ActivityItem[] | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  const chunk = useRef(50_000n);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    if (!net.contract) {
      setState({ data: [], error: null, loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    (async () => {
      try {
        const head = await pub.getBlockNumber();
        const start = net.deployBlock;
        const items: ActivityItem[] = [];
        let to = head;
        // Walk backwards from the head so the newest events arrive first.
        for (let i = 0; i < 400 && to >= start && items.length < limit; i++) {
          const from = to - chunk.current + 1n > start ? to - chunk.current + 1n : start;
          let logs: Log[];
          try {
            logs = (await pub.getContractEvents({ address: net.contract!, abi: payGateAbi, fromBlock: from, toBlock: to })) as Log[];
          } catch (e) {
            if (chunk.current > 1_000n) {
              chunk.current = chunk.current / 2n;
              i--;
              continue;
            }
            throw e;
          }
          for (const l of logs as unknown as { eventName: ActivityItem["kind"]; blockNumber: bigint; transactionHash: `0x${string}`; logIndex: number; args: Record<string, unknown> }[]) {
            items.push({ kind: l.eventName, block: l.blockNumber, tx: l.transactionHash, logIndex: l.logIndex, args: l.args, time: null });
          }
          to = from - 1n;
          if (from === start) break;
        }
        items.sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block > b.block ? -1 : 1));
        const top = items.slice(0, limit);
        const blocks = [...new Set(top.map((x) => x.block))].slice(0, 40);
        const times = new Map<bigint, number>();
        await Promise.all(
          blocks.map((b) =>
            pub
              .getBlock({ blockNumber: b })
              .then((blk) => times.set(b, Number(blk.timestamp)))
              .catch(() => undefined),
          ),
        );
        for (const x of top) x.time = times.get(x.block) ?? null;
        if (live) setState({ data: top, error: null, loading: false });
      } catch (e) {
        if (live) setState((s) => ({ data: s.data ?? [], error: (e as { shortMessage?: string }).shortMessage || (e as Error).message, loading: false }));
      }
    })();
    const t = setInterval(() => setNonce((n) => n + 1), 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [pub, net.contract, net.deployBlock, version, nonce, limit]);

  return { ...state, reload };
}
