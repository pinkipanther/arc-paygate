/**
 * An in-browser EVM chain for the Demo network.
 *
 * It runs the real PayGate creation bytecode in @ethereumjs/vm and answers the JSON-RPC methods viem uses,
 * so every page talks to it exactly as it talks to Arc: reads, simulations, signed transactions,
 * receipts, logs and blocks. Each transaction is mined into its own block. Nothing leaves the page.
 */
import { createVM, runTx, type VM } from "@ethereumjs/vm";
import { createTxFromRLP } from "@ethereumjs/tx";
import { createBlock, type Block } from "@ethereumjs/block";
import { createCustomCommon, Mainnet, Hardfork, type Common } from "@ethereumjs/common";
import { Account, createAddressFromString, createZeroAddress } from "@ethereumjs/util";
import { bytesToHex, hexToBytes, keccak256, numberToHex, toHex, type Hex } from "viem";

export const GAS_PRICE = 20_000_000_000n; // Arc's 20 gwei floor
const GAS_LIMIT = 30_000_000n;

interface LogRec {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
}

interface TxRec {
  hash: Hex;
  from: Hex;
  to: Hex | null;
  input: Hex;
  value: bigint;
  nonce: bigint;
  gas: bigint;
  blockNumber: bigint;
  blockHash: Hex;
  status: boolean;
  gasUsed: bigint;
  contractAddress: Hex | null;
  logs: LogRec[];
  type: number;
}

interface BlockRec {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: bigint;
  txs: Hex[];
  gasUsed: bigint;
}

type Req = { method: string; params?: unknown[] };

export class RpcError extends Error {
  code: number;
  data?: Hex;
  constructor(code: number, message: string, data?: Hex) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
const big = (v: unknown, d = 0n): bigint => (v === undefined || v === null ? d : BigInt(v as string));

export class DemoChain {
  readonly chainId: number;
  private vm!: VM;
  private common: Common;
  private blocks: BlockRec[] = [];
  private txs = new Map<Hex, TxRec>();
  private logs: LogRec[] = [];
  /** Lets the seeding step backdate blocks so the activity feed has a history. */
  clock: () => bigint = () => BigInt(Math.floor(Date.now() / 1000));

  constructor(chainId: number) {
    this.chainId = chainId;
    this.common = createCustomCommon({ chainId, name: "arc-demo" }, Mainnet, { hardfork: Hardfork.Cancun });
  }

  async init() {
    this.vm = await createVM({ common: this.common });
    const ts = this.clock();
    this.blocks.push({ number: 0n, hash: keccak256(toHex(`arc-demo-genesis-${ts}`)), parentHash: ZERO_HASH, timestamp: ts, txs: [], gasUsed: 0n });
  }

  get head(): BlockRec {
    return this.blocks[this.blocks.length - 1];
  }

  async fund(address: Hex, wei: bigint) {
    const a = createAddressFromString(address);
    const acct = (await this.vm.stateManager.getAccount(a)) ?? new Account();
    acct.balance = wei;
    await this.vm.stateManager.putAccount(a, acct);
  }

  private nextHeader(timestamp?: bigint) {
    const ts = timestamp ?? this.clock();
    return {
      number: this.head.number + 1n,
      timestamp: ts > this.head.timestamp ? ts : this.head.timestamp + 1n,
      gasLimit: GAS_LIMIT,
      baseFeePerGas: GAS_PRICE,
      coinbase: createZeroAddress(),
    };
  }

  private evmBlock(timestamp?: bigint): Block {
    return createBlock({ header: this.nextHeader(timestamp) }, { common: this.common, skipConsensusFormatValidation: true });
  }

  /** Runs a call against a throwaway checkpoint of the state. */
  private async call(p: { from?: Hex; to?: Hex | null; data?: Hex; input?: Hex; value?: Hex; gas?: Hex }) {
    const block = this.evmBlock();
    await this.vm.evm.journal.checkpoint();
    try {
      const res = await this.vm.evm.runCall({
        caller: p.from ? createAddressFromString(p.from) : createZeroAddress(),
        to: p.to ? createAddressFromString(p.to) : undefined,
        data: hexToBytes((p.data ?? p.input ?? "0x") as Hex),
        value: big(p.value),
        gasLimit: big(p.gas, GAS_LIMIT),
        gasPrice: GAS_PRICE,
        block,
        skipBalance: true,
      });
      return res.execResult;
    } finally {
      await this.vm.evm.journal.revert();
    }
  }

  async sendRaw(raw: Hex, timestamp?: bigint): Promise<Hex> {
    const tx = createTxFromRLP(hexToBytes(raw), { common: this.common });
    const hash = bytesToHex(tx.hash()) as Hex;
    const block = this.evmBlock(timestamp);
    const header = block.header;
    let res;
    try {
      res = await runTx(this.vm, { tx, block, skipBlockGasLimitValidation: true, skipHardForkValidation: true });
    } catch (e) {
      throw new RpcError(-32000, (e as Error).message.split("\n")[0].replace(/\s*\(.*$/, ""));
    }
    const number = header.number;
    const blockHash = keccak256(toHex(`arc-demo-block-${number}-${hash}`));
    const ok = !res.execResult.exceptionError;
    const logs: LogRec[] = ok
      ? (res.execResult.logs ?? []).map(([addr, topics, data], i) => ({
          address: bytesToHex(addr) as Hex,
          topics: topics.map((t) => bytesToHex(t) as Hex),
          data: bytesToHex(data) as Hex,
          blockNumber: number,
          blockHash,
          transactionHash: hash,
          transactionIndex: 0,
          logIndex: i,
        }))
      : [];
    const from = tx.getSenderAddress().toString() as Hex;
    const rec: TxRec = {
      hash,
      from,
      to: tx.to ? (tx.to.toString() as Hex) : null,
      input: bytesToHex(tx.data) as Hex,
      value: tx.value,
      nonce: tx.nonce,
      gas: tx.gasLimit,
      blockNumber: number,
      blockHash,
      status: ok,
      gasUsed: res.totalGasSpent,
      contractAddress: res.createdAddress ? (res.createdAddress.toString() as Hex) : null,
      logs,
      type: tx.type,
    };
    this.txs.set(hash, rec);
    this.logs.push(...logs);
    this.blocks.push({ number, hash: blockHash, parentHash: this.head.hash, timestamp: header.timestamp, txs: [hash], gasUsed: res.totalGasSpent });
    return hash;
  }

  private blockAt(tag: unknown): BlockRec | null {
    if (tag === undefined || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") return this.head;
    if (tag === "earliest") return this.blocks[0];
    const n = Number(BigInt(tag as string));
    return this.blocks[n] ?? null;
  }

  private blockJson(b: BlockRec, full: boolean) {
    return {
      number: numberToHex(b.number),
      hash: b.hash,
      parentHash: b.parentHash,
      timestamp: numberToHex(b.timestamp),
      gasLimit: numberToHex(GAS_LIMIT),
      gasUsed: numberToHex(b.gasUsed),
      baseFeePerGas: numberToHex(GAS_PRICE),
      miner: "0x0000000000000000000000000000000000000000",
      difficulty: "0x0",
      totalDifficulty: "0x0",
      extraData: "0x",
      size: "0x0",
      nonce: "0x0000000000000000",
      mixHash: ZERO_HASH,
      sha3Uncles: ZERO_HASH,
      logsBloom: `0x${"0".repeat(512)}`,
      transactionsRoot: ZERO_HASH,
      stateRoot: ZERO_HASH,
      receiptsRoot: ZERO_HASH,
      uncles: [],
      transactions: full ? b.txs.map((h) => this.txJson(this.txs.get(h)!)) : b.txs,
    };
  }

  private txJson(t: TxRec) {
    return {
      hash: t.hash,
      from: t.from,
      to: t.to,
      input: t.input,
      value: numberToHex(t.value),
      nonce: numberToHex(t.nonce),
      gas: numberToHex(t.gas),
      gasPrice: numberToHex(GAS_PRICE),
      maxFeePerGas: numberToHex(GAS_PRICE),
      maxPriorityFeePerGas: "0x0",
      blockNumber: numberToHex(t.blockNumber),
      blockHash: t.blockHash,
      transactionIndex: "0x0",
      type: numberToHex(t.type),
      chainId: numberToHex(this.chainId),
      v: "0x0",
      r: "0x0",
      s: "0x0",
    };
  }

  private logJson(l: LogRec) {
    return {
      address: l.address,
      topics: l.topics,
      data: l.data,
      blockNumber: numberToHex(l.blockNumber),
      blockHash: l.blockHash,
      transactionHash: l.transactionHash,
      transactionIndex: numberToHex(l.transactionIndex),
      logIndex: numberToHex(l.logIndex),
      removed: false,
    };
  }

  async request({ method, params = [] }: Req): Promise<unknown> {
    const p = params as never[];
    switch (method) {
      case "eth_chainId":
        return numberToHex(this.chainId);
      case "net_version":
        return String(this.chainId);
      case "eth_blockNumber":
        return numberToHex(this.head.number);
      case "eth_gasPrice":
        return numberToHex(GAS_PRICE);
      case "eth_maxPriorityFeePerGas":
        return "0x0";
      case "eth_feeHistory":
        return { oldestBlock: numberToHex(this.head.number), baseFeePerGas: [numberToHex(GAS_PRICE), numberToHex(GAS_PRICE)], gasUsedRatio: [0], reward: [["0x0"]] };
      case "eth_getBalance": {
        const a = await this.vm.stateManager.getAccount(createAddressFromString(p[0]));
        return numberToHex(a?.balance ?? 0n);
      }
      case "eth_getTransactionCount": {
        const a = await this.vm.stateManager.getAccount(createAddressFromString(p[0]));
        return numberToHex(a?.nonce ?? 0n);
      }
      case "eth_getCode":
        return bytesToHex(await this.vm.stateManager.getCode(createAddressFromString(p[0])));
      case "eth_call": {
        const r = await this.call(p[0]);
        if (r.exceptionError) throw new RpcError(3, "execution reverted", bytesToHex(r.returnValue) as Hex);
        return bytesToHex(r.returnValue);
      }
      case "eth_estimateGas": {
        const tx = p[0] as { data?: Hex; input?: Hex; to?: Hex | null };
        const r = await this.call(tx);
        if (r.exceptionError) throw new RpcError(3, "execution reverted", bytesToHex(r.returnValue) as Hex);
        const data = hexToBytes((tx.data ?? tx.input ?? "0x") as Hex);
        let intrinsic = 21_000n + (tx.to ? 0n : 32_000n);
        for (const byte of data) intrinsic += byte === 0 ? 4n : 16n;
        return numberToHex(((r.executionGasUsed + intrinsic) * 13n) / 10n + 10_000n);
      }
      case "eth_sendRawTransaction":
        return this.sendRaw(p[0]);
      case "eth_getTransactionReceipt": {
        const t = this.txs.get(p[0]);
        if (!t) return null;
        return {
          transactionHash: t.hash,
          transactionIndex: "0x0",
          blockHash: t.blockHash,
          blockNumber: numberToHex(t.blockNumber),
          from: t.from,
          to: t.to,
          cumulativeGasUsed: numberToHex(t.gasUsed),
          gasUsed: numberToHex(t.gasUsed),
          effectiveGasPrice: numberToHex(GAS_PRICE),
          contractAddress: t.contractAddress,
          logs: t.logs.map((l) => this.logJson(l)),
          logsBloom: `0x${"0".repeat(512)}`,
          status: t.status ? "0x1" : "0x0",
          type: numberToHex(t.type),
        };
      }
      case "eth_getTransactionByHash": {
        const t = this.txs.get(p[0]);
        return t ? this.txJson(t) : null;
      }
      case "eth_getBlockByNumber": {
        const b = this.blockAt(p[0]);
        return b ? this.blockJson(b, !!p[1]) : null;
      }
      case "eth_getBlockByHash": {
        const b = this.blocks.find((x) => x.hash === p[0]);
        return b ? this.blockJson(b, !!p[1]) : null;
      }
      case "eth_getLogs": {
        const f = p[0] as { address?: Hex | Hex[]; topics?: (Hex | Hex[] | null)[]; fromBlock?: Hex; toBlock?: Hex; blockHash?: Hex };
        const from = f.blockHash ? null : (this.blockAt(f.fromBlock ?? "earliest")?.number ?? 0n);
        const to = f.blockHash ? null : (this.blockAt(f.toBlock ?? "latest")?.number ?? this.head.number);
        const addrs = f.address ? (Array.isArray(f.address) ? f.address : [f.address]).map((a) => a.toLowerCase()) : null;
        return this.logs
          .filter((l) => (f.blockHash ? l.blockHash === f.blockHash : l.blockNumber >= from! && l.blockNumber <= to!))
          .filter((l) => !addrs || addrs.includes(l.address.toLowerCase()))
          .filter((l) =>
            (f.topics ?? []).every((t, i) => t === null || t === undefined || (Array.isArray(t) ? t.map((x) => x.toLowerCase()).includes(l.topics[i]?.toLowerCase()) : t.toLowerCase() === l.topics[i]?.toLowerCase())),
          )
          .map((l) => this.logJson(l));
      }
      case "eth_accounts":
      case "eth_requestAccounts":
        return [];
      default:
        throw new RpcError(-32601, `Demo chain does not support ${method}`);
    }
  }
}
