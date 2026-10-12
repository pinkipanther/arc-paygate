/** Signatures are valid for the current and previous five-minute bucket. */
export const NONCE_PERIOD = 300;

/** Must match py/server.py exactly; see /.well-known/paygate.json → message_format. */
export function authMessage(chainId: number, contract: string, rid: bigint, nonce: number, host: string): string {
  return `paygate:2:${chainId}:${contract.toLowerCase()}:${rid}:${nonce}:${host.toLowerCase()}`;
}
