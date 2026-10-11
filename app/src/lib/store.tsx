import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  http,
  numberToHex,
  type Address,
  type PublicClient,
  type WalletClient,
  type EIP1193Provider,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS, DEFAULT_NET, NET_KEYS, type NetKey, type Network } from "../config";
import { discoverWallets, rememberWallet, rememberedWallet, rememberNet, rememberedNet, type DiscoveredWallet } from "./wallet";

export interface Toast {
  id: number;
  tone: "pending" | "ok" | "err" | "info";
  title: string;
  body?: string;
  href?: string;
}

export interface Connected {
  address: Address;
  chainId: number;
  name: string;
  icon: string;
  rdns: string;
  provider: EIP1193Provider | null;
  /** Local dev accounts sign in-page; injected wallets sign in the extension. */
  local: boolean;
}

interface Ctx {
  netKey: NetKey;
  net: Network;
  setNet: (k: NetKey) => void;
  pub: PublicClient;
  wallets: DiscoveredWallet[];
  wallet: Connected | null;
  connecting: boolean;
  connect: (w: DiscoveredWallet | "dev") => Promise<void>;
  disconnect: () => void;
  walletOpen: boolean;
  openWallet: (v: boolean) => void;
  /** Returns a wallet client on the selected network, switching or adding the chain if needed. */
  signer: () => Promise<WalletClient>;
  toasts: Toast[];
  toast: (t: Omit<Toast, "id">) => number;
  updateToast: (id: number, t: Partial<Toast>) => void;
  dismiss: (id: number) => void;
  /** Bumped after every confirmed transaction so views refetch. */
  version: number;
  bump: () => void;
}

const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside provider");
  return c;
}

// anvil's first two dev keys; only used against a local chain in dev builds.
const DEV_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

function makePublic(net: Network): PublicClient {
  return createPublicClient({
    chain: net.chain,
    transport: fallback(
      net.reads.map((u) => http(u, { timeout: 12_000, retryCount: 1 })),
      { rank: false },
    ),
    pollingInterval: 2_000,
  }) as PublicClient;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const initial = ((): NetKey => {
    const r = rememberedNet() as NetKey | null;
    return r && NET_KEYS.includes(r) ? r : DEFAULT_NET;
  })();
  const [netKey, setNetKey] = useState<NetKey>(initial);
  const net = NETWORKS[netKey];
  const pub = useMemo(() => makePublic(net), [net]);
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [wallet, setWallet] = useState<Connected | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [walletOpen, openWallet] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [version, setVersion] = useState(0);
  const seq = useRef(1);
  const autoTried = useRef(false);

  const setNet = useCallback((k: NetKey) => {
    rememberNet(k);
    setNetKey(k);
  }, []);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = seq.current++;
      setToasts((xs) => [...xs.slice(-3), { ...t, id }]);
      if (t.tone !== "pending") setTimeout(() => dismiss(id), t.tone === "err" ? 9000 : 5000);
      return id;
    },
    [dismiss],
  );
  const updateToast = useCallback(
    (id: number, patch: Partial<Toast>) => {
      setToasts((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
      if (patch.tone && patch.tone !== "pending") setTimeout(() => dismiss(id), patch.tone === "err" ? 9000 : 5000);
    },
    [dismiss],
  );
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => discoverWallets(setWallets), []);

  const attach = useCallback(async (w: DiscoveredWallet, request: boolean) => {
    const method = request ? "eth_requestAccounts" : "eth_accounts";
    const accounts = (await w.provider.request({ method } as never)) as Address[];
    if (!accounts?.length) return false;
    const chainHex = (await w.provider.request({ method: "eth_chainId" } as never)) as string;
    setWallet({
      address: accounts[0],
      chainId: Number(chainHex),
      name: w.info.name,
      icon: w.info.icon,
      rdns: w.info.rdns,
      provider: w.provider,
      local: false,
    });
    rememberWallet(w.info.rdns);
    return true;
  }, []);

  const connect = useCallback(
    async (w: DiscoveredWallet | "dev") => {
      setConnecting(true);
      try {
        if (w === "dev") {
          const acct = privateKeyToAccount(DEV_KEY);
          setWallet({ address: acct.address, chainId: NETWORKS.local.chain.id, name: "Anvil dev account", icon: "", rdns: "dev", provider: null, local: true });
        } else {
          await attach(w, true);
        }
        openWallet(false);
      } catch (e) {
        const msg = (e as { shortMessage?: string; message?: string }).shortMessage || (e as Error).message;
        toast({ tone: "err", title: "Wallet did not connect", body: /reject|denied/i.test(msg) ? "You closed the request in your wallet." : msg });
      } finally {
        setConnecting(false);
      }
    },
    [attach, toast],
  );

  const disconnect = useCallback(() => {
    setWallet(null);
    rememberWallet(null);
  }, []);

  // Silent reconnect to the last wallet (eth_accounts never prompts).
  useEffect(() => {
    if (autoTried.current || wallets.length === 0) return;
    const r = rememberedWallet();
    const w = wallets.find((x) => x.info.rdns === r);
    if (!w) return;
    autoTried.current = true;
    attach(w, false).catch(() => undefined);
  }, [wallets, attach]);

  // Follow account and chain changes in the extension.
  useEffect(() => {
    const p = wallet?.provider as (EIP1193Provider & { removeListener?: (e: string, f: (...a: unknown[]) => void) => void }) | null;
    if (!p) return;
    const onAccounts = (...a: unknown[]) => {
      const accs = a[0] as Address[];
      if (!accs?.length) setWallet(null);
      else setWallet((w) => (w ? { ...w, address: accs[0] } : w));
    };
    const onChain = (...a: unknown[]) => setWallet((w) => (w ? { ...w, chainId: Number(a[0] as string) } : w));
    p.on("accountsChanged", onAccounts as never);
    p.on("chainChanged", onChain as never);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [wallet?.provider]);

  const signer = useCallback(async (): Promise<WalletClient> => {
    if (!wallet) {
      openWallet(true);
      throw new Error("Connect a wallet first.");
    }
    if (wallet.local) {
      if (net.key !== "local") throw new Error("The dev account only works on the local chain.");
      return createWalletClient({ account: privateKeyToAccount(DEV_KEY), chain: net.chain, transport: http(net.reads[0]) });
    }
    const p = wallet.provider!;
    const want = net.chain.id;
    const current = Number((await p.request({ method: "eth_chainId" } as never)) as string);
    if (current !== want) {
      try {
        await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(want) }] } as never);
      } catch (e) {
        const code = (e as { code?: number }).code;
        if (code === 4902 || /unrecognized|not been added|unknown chain/i.test((e as Error).message || "")) {
          await p.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: numberToHex(want),
                chainName: net.chain.name,
                nativeCurrency: net.chain.nativeCurrency,
                rpcUrls: [net.walletRpc],
                blockExplorerUrls: net.explorer ? [net.explorer] : undefined,
              },
            ],
          } as never);
        } else throw e;
      }
      setWallet((w) => (w ? { ...w, chainId: want } : w));
    }
    return createWalletClient({ account: wallet.address, chain: net.chain, transport: custom(p) });
  }, [wallet, net]);

  const value: Ctx = {
    netKey,
    net,
    setNet,
    pub,
    wallets,
    wallet,
    connecting,
    connect,
    disconnect,
    walletOpen,
    openWallet,
    signer,
    toasts,
    toast,
    updateToast,
    dismiss,
    version,
    bump,
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
