/**
 * The Demo network: the real PayGate bytecode on an in-browser EVM (./chain.ts), seeded with a few
 * listings and a purchase history, plus a funded wallet for the visitor. It exists so anyone can try the
 * full list → pay → prove → 200 loop without a browser wallet or testnet funds. State resets on reload.
 */
import { createWalletClient, custom, defineChain, getContractAddress, keccak256, parseEther, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { payGateAbi } from "../abi";
import { buildMeta } from "../lib/meta";
import type { DemoChain } from "./chain";

export const DEMO_CHAIN_ID = 5042999;
export const DEMO_HOST = "api.paygate.example";
export const DEMO_START_BALANCE = parseEther("25");

export const demoChain = defineChain({
  id: DEMO_CHAIN_ID,
  name: "Arc Demo",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://demo.invalid"] } },
  testnet: true,
});

const key = (label: string) => keccak256(toHex(`paygate-demo:${label}`));
const DEPLOYER = privateKeyToAccount(key("seller:0"));
const SELLER_2 = privateKeyToAccount(key("seller:1"));
const AGENTS = [0, 1, 2, 3].map((i) => privateKeyToAccount(key(`agent:${i}`)));

export const DEMO_CONTRACT: Address = getContractAddress({ from: DEPLOYER.address, nonce: 0n });

/** The visitor's wallet: a fresh key per page load, funded on first use. */
const visitorKey: Hex = generatePrivateKey();
export const demoVisitor = privateKeyToAccount(visitorKey);

const LISTINGS = [
  {
    by: DEPLOYER,
    price: "0.01",
    window: 3600,
    meta: {
      name: "Polymarket reward pools",
      desc: "Live screener of Polymarket liquidity-reward pools: USDC per day, minimum size and spread band for every rewarded market.",
      url: `https://${DEMO_HOST}/api/polymarket-rewards`,
      kind: "dataset",
    },
  },
  {
    by: DEPLOYER,
    price: "0.25",
    window: 86400,
    meta: {
      name: "BTC 5-minute book replay",
      desc: "Top-of-book snapshots for Polymarket BTC up/down 5-minute markets with matching Binance trades, one file per day, for backtests.",
      url: `https://${DEMO_HOST}/api/btc-5m-replay`,
      kind: "dataset",
    },
  },
  {
    by: SELLER_2,
    price: "0.001",
    window: 900,
    meta: {
      name: "Arc gas & block oracle",
      desc: "Latest block, base fee and a 5-minute gas forecast for Arc, so agents can price transactions before sending them.",
      url: `https://${DEMO_HOST}/api/arc-gas`,
      kind: "api",
    },
  },
  {
    by: SELLER_2,
    price: "0.05",
    window: 3600,
    meta: {
      name: "Agent web search",
      desc: "Search proxy for agents: ten ranked results with clean text extracts per query, no API key or account needed.",
      url: `https://${DEMO_HOST}/api/search`,
      kind: "api",
    },
  },
];

// [listing index, agent index, seconds ago]
const PURCHASES: [number, number, number][] = [
  [0, 0, 2 * 86400 + 4000],
  [2, 1, 2 * 86400 + 1200],
  [1, 2, 36 * 3600],
  [0, 1, 30 * 3600],
  [3, 0, 26 * 3600],
  [2, 3, 20 * 3600],
  [0, 2, 9 * 3600],
  [3, 3, 5 * 3600],
  [2, 1, 3 * 3600],
  [1, 0, 2 * 3600],
  [0, 3, 50 * 60],
  [0, 0, 20 * 60],
];

let ready: Promise<DemoChain> | null = null;

async function seed(): Promise<DemoChain> {
  const { DemoChain } = await import("./chain");
  const { PAYGATE_BYTECODE } = await import("./bytecode");
  const chain = new DemoChain(DEMO_CHAIN_ID);
  const now = BigInt(Math.floor(Date.now() / 1000));
  chain.clock = () => now - 3n * 86400n;
  await chain.init();

  for (const a of [DEPLOYER, SELLER_2, ...AGENTS]) await chain.fund(a.address, parseEther("100"));
  await chain.fund(demoVisitor.address, DEMO_START_BALANCE);

  const transport = custom({ request: (r) => chain.request(r as never) });
  const wallet = (acct: typeof DEPLOYER) => createWalletClient({ account: acct, chain: demoChain, transport });
  const at = (secondsAgo: number) => {
    chain.clock = () => now - BigInt(secondsAgo);
  };
  const common = { gas: 600_000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 0n } as const;

  at(3 * 86400 - 60);
  await wallet(DEPLOYER).deployContract({ abi: payGateAbi, bytecode: PAYGATE_BYTECODE, gas: 3_000_000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 0n });

  for (const [i, l] of LISTINGS.entries()) {
    at(3 * 86400 - 600 * (i + 1));
    await wallet(l.by).writeContract({
      address: DEMO_CONTRACT,
      abi: payGateAbi,
      functionName: "createResource",
      args: [parseEther(l.price), l.window, buildMeta(l.meta)],
      ...common,
    });
  }

  // Block times only move forward, so the second seller's withdrawal is replayed in time order.
  const WITHDRAW_AGO = 12 * 3600;
  let withdrawn = false;
  for (const [li, ai, ago] of PURCHASES) {
    if (!withdrawn && ago < WITHDRAW_AGO) {
      at(WITHDRAW_AGO);
      await wallet(SELLER_2).writeContract({ address: DEMO_CONTRACT, abi: payGateAbi, functionName: "withdraw", args: [], ...common });
      withdrawn = true;
    }
    at(ago);
    await wallet(AGENTS[ai]).writeContract({
      address: DEMO_CONTRACT,
      abi: payGateAbi,
      functionName: "pay",
      args: [BigInt(li + 1), LISTINGS[li].window],
      value: parseEther(LISTINGS[li].price),
      ...common,
    });
  }

  chain.clock = () => BigInt(Math.floor(Date.now() / 1000));
  return chain;
}

/** Lazily boots the demo chain (the EVM is only downloaded when someone opens the Demo network). */
export function demoChainReady(): Promise<DemoChain> {
  if (!ready) {
    ready = seed().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

export async function demoRequest(r: { method: string; params?: unknown }): Promise<unknown> {
  const chain = await demoChainReady();
  return chain.request(r as never);
}

export function demoSigner() {
  return createWalletClient({ account: demoVisitor, chain: demoChain, transport: custom({ request: demoRequest }) });
}
