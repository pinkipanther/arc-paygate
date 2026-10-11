import { formatUnits, parseUnits, type Address } from "viem";

/** Native USDC on Arc uses 18 decimals in msg.value. */
export const DECIMALS = 18;

export function usdc(wei: bigint, maxFrac = 4): string {
  if (wei === 0n) return "0";
  const n = Number(formatUnits(wei, DECIMALS));
  if (n > 0 && n < 10 ** -maxFrac) return `<${(10 ** -maxFrac).toFixed(maxFrac)}`;
  return n.toLocaleString("en-US", {
    maximumFractionDigits: maxFrac,
    minimumFractionDigits: n < 1 ? 2 : 0,
  });
}

export function parseUsdc(v: string): bigint | null {
  const s = v.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  try {
    return parseUnits(s, DECIMALS);
  } catch {
    return null;
  }
}

export function short(a?: string | null, head = 6, tail = 4): string {
  if (!a) return "—";
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

export function sameAddr(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function duration(seconds: number): string {
  if (seconds <= 0) return "0 sec";
  const units: [number, string, string][] = [
    [604800, "week", "weeks"],
    [86400, "day", "days"],
    [3600, "hour", "hours"],
    [60, "min", "min"],
    [1, "sec", "sec"],
  ];
  for (const [size, one, many] of units) {
    if (seconds >= size && seconds % size === 0) {
      const n = seconds / size;
      return `${n} ${n === 1 ? one : many}`;
    }
  }
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} hours`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${seconds} sec`;
}

/** "hour", "day", "7 days", "15 min": reads naturally after "per". */
export function perWindow(seconds: number): string {
  const d = duration(seconds);
  return d.startsWith("1 ") ? d.slice(2) : d;
}

/** 59:07, 3:04:05 or 2d 03:04:05 */
export function countdown(left: number): string {
  if (left <= 0) return "0:00";
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const pad = (x: number) => String(x).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

export function dateTime(unix: number | bigint): string {
  return new Date(Number(unix) * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ago(unix: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function isAddress(v: string): v is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(v.trim());
}

export const intFmt = (n: number | bigint) => Number(n).toLocaleString("en-US");
