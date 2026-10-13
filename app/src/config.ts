import { defineChain, type Address, type Chain } from "viem";
import { demoChain, DEMO_CONTRACT } from "./demo";

export type NetKey = "testnet" | "mainnet" | "demo" | "local";

export interface Network {
  key: NetKey;
  label: string;
  short: string;
  chain: Chain;
  /** RPCs this page reads from, in order. Circle's endpoint serves event logs; dRPC's free tier
   *  refuses eth_getLogs on Arc, so it is only the fallback. */
  reads: string[];
  /** RPC advertised to the wallet when it has to add the chain. */
  walletRpc: string;
  explorer: string | null;
  faucet: string | null;
  contract: Address | null;
  /** First block worth scanning for events (the deployment block). */
  deployBlock: bigint;
  /** Runs in the page (see src/demo): real contract bytecode, simulated chain, no wallet needed. */
  simulated?: boolean;
}

const usdc = { name: "USDC", symbol: "USDC", decimals: 18 } as const;

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: usdc,
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: usdc,
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});

const anvil = defineChain({
  id: 31337,
  name: "Local Anvil",
  nativeCurrency: usdc,
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

const addr = (v: string | undefined): Address | null => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null);

export const NETWORKS: Record<NetKey, Network> = {
  testnet: {
    key: "testnet",
    label: "Arc Testnet",
    short: "Testnet",
    chain: arcTestnet,
    reads: ["https://rpc.testnet.arc.io", "https://arc-testnet.drpc.org"],
    walletRpc: "https://rpc.testnet.arc.io",
    explorer: "https://testnet.arcscan.app",
    faucet: "https://faucet.circle.com",
    contract: addr(import.meta.env.VITE_TESTNET_PAYGATE) ?? null,
    deployBlock: BigInt(import.meta.env.VITE_TESTNET_DEPLOY_BLOCK ?? "0"),
  },
  mainnet: {
    key: "mainnet",
    label: "Arc Mainnet",
    short: "Mainnet",
    chain: arcMainnet,
    reads: ["https://rpc.mainnet.arc.io", "https://arc.drpc.org"],
    walletRpc: "https://rpc.mainnet.arc.io",
    explorer: "https://explorer.arc.io",
    faucet: null,
    contract: addr(import.meta.env.VITE_MAINNET_PAYGATE) ?? null,
    deployBlock: BigInt(import.meta.env.VITE_MAINNET_DEPLOY_BLOCK ?? "0"),
  },
  demo: {
    key: "demo",
    label: "Arc Demo",
    short: "Demo",
    chain: demoChain,
    reads: [],
    walletRpc: "",
    explorer: null,
    faucet: null,
    contract: DEMO_CONTRACT,
    deployBlock: 0n,
    simulated: true,
  },
  local: {
    key: "local",
    label: "Local Anvil",
    short: "Local",
    chain: anvil,
    reads: ["http://127.0.0.1:8545"],
    walletRpc: "http://127.0.0.1:8545",
    explorer: null,
    faucet: null,
    contract: addr(import.meta.env.VITE_LOCAL_PAYGATE) ?? null,
    deployBlock: 0n,
  },
};

/** Networks offered in the switcher. The local chain only exists in dev builds. */
export const NET_KEYS: NetKey[] = import.meta.env.DEV && NETWORKS.local.contract ? ["testnet", "mainnet", "demo", "local"] : ["testnet", "mainnet", "demo"];

/** Open on a live Arc deployment when there is one; otherwise on the in-browser demo. */
export const DEFAULT_NET: NetKey = (() => {
  if (import.meta.env.DEV && NETWORKS.local.contract) return "local";
  if (NETWORKS.testnet.contract) return "testnet";
  if (NETWORKS.mainnet.contract) return "mainnet";
  return "demo";
})();

export const REPO = "https://github.com/pinkipanther/arc-paygate";
export const MAX_URI = 512;
