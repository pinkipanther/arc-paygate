import type { EIP1193Provider } from "viem";

/** EIP-6963: wallets announce themselves, so several extensions can coexist without fighting over window.ethereum. */
export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface DiscoveredWallet {
  info: WalletInfo;
  provider: EIP1193Provider;
}

type AnnounceEvent = CustomEvent<DiscoveredWallet>;

export function discoverWallets(onChange: (list: DiscoveredWallet[]) => void): () => void {
  const found = new Map<string, DiscoveredWallet>();
  const handler = (e: Event) => {
    const d = (e as AnnounceEvent).detail;
    if (!d?.info?.rdns || !d.provider) return;
    found.set(d.info.rdns, d);
    onChange([...found.values()]);
  };
  window.addEventListener("eip6963:announceProvider", handler);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  // Legacy fallback: a wallet that only injects window.ethereum.
  const legacy = setTimeout(() => {
    const eth = (window as unknown as { ethereum?: EIP1193Provider & { isMetaMask?: boolean; isRabby?: boolean } }).ethereum;
    if (found.size === 0 && eth) {
      const name = eth.isRabby ? "Rabby" : eth.isMetaMask ? "MetaMask" : "Browser wallet";
      found.set("injected", { info: { uuid: "injected", name, icon: "", rdns: "injected" }, provider: eth });
      onChange([...found.values()]);
    }
  }, 600);

  return () => {
    window.removeEventListener("eip6963:announceProvider", handler);
    clearTimeout(legacy);
  };
}

const KEY = "paygate.wallet";
export const rememberWallet = (rdns: string | null) => {
  try {
    if (rdns) localStorage.setItem(KEY, rdns);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
};
export const rememberedWallet = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

export const NET_KEY = "paygate.net";
export const rememberNet = (k: string) => {
  try {
    localStorage.setItem(NET_KEY, k);
  } catch {
    /* ignore */
  }
};
export const rememberedNet = (): string | null => {
  try {
    return localStorage.getItem(NET_KEY);
  } catch {
    return null;
  }
};
