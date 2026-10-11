import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, type Hash, type TransactionReceipt } from "viem";
import { payGateAbi, ERROR_TEXT } from "../abi";
import { useApp } from "./store";
import { useCallback } from "react";

export type Stage = "check" | "sign" | "settle" | "done";

/** Turns any wallet/RPC/contract error into one sentence a person can act on. */
export function explain(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = revert?.data?.errorName;
    if (name && ERROR_TEXT[name]) return ERROR_TEXT[name];
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return "You rejected the request in your wallet.";
    const msg = e.shortMessage || e.message;
    if (/insufficient funds|exceeds the balance/i.test(msg)) return "Not enough USDC in this wallet to cover the price plus gas.";
    if (/user rejected|denied/i.test(msg)) return "You rejected the request in your wallet.";
    return msg.split("\n")[0];
  }
  const m = (e as Error)?.message || String(e);
  if (/user rejected|denied|4001/i.test(m)) return "You rejected the request in your wallet.";
  return m.split("\n")[0];
}

type WriteName = "createResource" | "updateResource" | "transferResource" | "pay" | "payFor" | "withdraw" | "withdrawTo";

export interface TxRequest {
  label: string;
  functionName: WriteName;
  args: readonly unknown[];
  value?: bigint;
  success?: (r: TransactionReceipt) => string;
}

/** Simulate (to surface reverts before the wallet opens), sign, wait, and narrate it all in a toast. */
export function useTx() {
  const { pub, net, wallet, signer, toast, updateToast, bump } = useApp();
  return useCallback(
    async (req: TxRequest, onStage?: (s: Stage, hash?: Hash) => void): Promise<TransactionReceipt> => {
      if (!net.contract) throw new Error("PayGate is not deployed on this network.");
      const id = toast({ tone: "pending", title: req.label, body: "Checking the terms on-chain…" });
      try {
        onStage?.("check");
        const wc = await signer();
        const account = wc.account ?? wallet!.address;
        const { request } = await pub.simulateContract({
          address: net.contract,
          abi: payGateAbi,
          functionName: req.functionName,
          args: req.args as never,
          value: req.value,
          account,
        } as never);
        onStage?.("sign");
        updateToast(id, { body: wallet?.local ? "Signing with the dev account…" : `Confirm in ${wallet?.name ?? "your wallet"}` });
        const hash = await wc.writeContract(request as never);
        onStage?.("settle", hash);
        updateToast(id, { body: "Settling on Arc…", href: net.explorer ? `${net.explorer}/tx/${hash}` : undefined });
        const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
        if (receipt.status !== "success") throw new Error("The transaction reverted on-chain.");
        onStage?.("done", hash);
        updateToast(id, { tone: "ok", body: req.success ? req.success(receipt) : `Confirmed in block ${receipt.blockNumber.toLocaleString()}` });
        bump();
        return receipt;
      } catch (e) {
        updateToast(id, { tone: "err", body: explain(e) });
        throw e;
      }
    },
    [pub, net, wallet, signer, toast, updateToast, bump],
  );
}
