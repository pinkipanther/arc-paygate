import { useMemo, useState, type ReactNode } from "react";
import { formatUnits, getAddress } from "viem";
import { ArrowDownToLine, PackageOpen, Pencil, Plus, Send, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { MAX_URI } from "../config";
import { Pass } from "../components/Pass";
import { NotDeployed } from "../components/NotDeployed";
import { Empty, Eyebrow, PageHeader, Spinner } from "../components/common";
import { duration, intFmt, isAddress, parseUsdc, sameAddr, usdc } from "../lib/format";
import { useBalance, useResources, type Resource } from "../lib/hooks";
import { buildMeta, byteLength, parseMeta } from "../lib/meta";
import { useApp } from "../lib/store";
import { useTx } from "../lib/tx";

const MAX_WINDOW = 365 * 86400;
const WINDOWS: [number, string][] = [
  [900, "15m"],
  [3600, "1h"],
  [86400, "1d"],
  [604800, "7d"],
  [2592000, "30d"],
];
const PRICES = ["0.01", "0.05", "0.10", "1.00"];

interface Draft {
  name: string;
  desc: string;
  url: string;
  price: string;
  window: number;
  customMin: string;
}

const blank: Draft = { name: "", desc: "", url: "", price: "0.01", window: 3600, customMin: "" };

function validate(d: Draft) {
  const price = parseUsdc(d.price);
  const window = d.window === -1 ? Math.round(Number(d.customMin) * 60) : d.window;
  const uri = buildMeta({ name: d.name, desc: d.desc, url: d.url });
  const bytes = byteLength(uri);
  const errs: Partial<Record<"name" | "url" | "price" | "window" | "uri", string>> = {};
  if (!d.name.trim()) errs.name = "Add a name.";
  if (d.url.trim() && !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(d.url.trim())) errs.url = "Use a full https:// URL.";
  if (price === null) errs.price = "Enter a price, e.g. 0.05.";
  else if (/\.\d{7,}/.test(d.price.trim())) errs.price = "Max 6 decimals.";
  else if (price >= 2n ** 96n) errs.price = "Too large.";
  if (!Number.isFinite(window) || window < 1) errs.window = "Pick a window.";
  else if (window > MAX_WINDOW) errs.window = "Max 365 days.";
  if (bytes > MAX_URI) errs.uri = `${bytes}/${MAX_URI} bytes. Shorten the description.`;
  return { price, window, uri, bytes, errs, ok: Object.keys(errs).length === 0 };
}

function Field({ label, htmlFor, err, children, hint }: { label: string; htmlFor?: string; err?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {err ? <p className="text-xs text-destructive">{err}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** `show` turns on every error (after a submit attempt); before that only fields with input show theirs. */
function TermsFields({ d, set, v, show = false }: { d: Draft; set: (p: Partial<Draft>) => void; v: ReturnType<typeof validate>; show?: boolean }) {
  const nameErr = show || d.name !== "" ? v.errs.name : undefined;
  return (
    <div className="space-y-5">
      <Field label="Name" htmlFor="f-name" err={nameErr}>
        <Input id="f-name" placeholder="e.g. Weather API" value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} aria-invalid={!!nameErr} />
      </Field>
      <Field label="Description" htmlFor="f-desc" hint="Optional. One line on what buyers get.">
        <Textarea id="f-desc" rows={2} placeholder="e.g. Hourly forecasts for 200 cities, JSON" value={d.desc} onChange={(e) => set({ desc: e.target.value })} />
      </Field>
      <Field label="Endpoint" htmlFor="f-url" err={v.errs.url} hint="Optional. The URL your server answers; buyers sign requests for its host.">
        <Input id="f-url" className="font-mono text-sm" placeholder="https://api.example.com/v1/data" value={d.url} onChange={(e) => set({ url: e.target.value })} spellCheck={false} aria-invalid={!!v.errs.url} />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Price (USDC)" htmlFor="f-price" err={v.errs.price}>
          <Input id="f-price" className="font-mono" inputMode="decimal" value={d.price} onChange={(e) => set({ price: e.target.value })} aria-invalid={!!v.errs.price} />
          <ToggleGroup type="single" value={PRICES.includes(d.price) ? d.price : ""} onValueChange={(p) => p && set({ price: p })} className="justify-start" variant="outline" size="sm">
            {PRICES.map((p) => (
              <ToggleGroupItem key={p} value={p} className="font-mono text-xs">
                {p}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <Field label="Access window" err={v.errs.window}>
          <ToggleGroup type="single" value={String(d.window)} onValueChange={(w) => w && set({ window: Number(w) })} className="flex-wrap justify-start" variant="outline" size="sm">
            {WINDOWS.map(([s, l]) => (
              <ToggleGroupItem key={s} value={String(s)} className="font-mono text-xs">
                {l}
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem value="-1" className="text-xs">
              Custom
            </ToggleGroupItem>
          </ToggleGroup>
          {d.window === -1 && <Input className="font-mono" inputMode="numeric" placeholder="Minutes, e.g. 90" value={d.customMin} onChange={(e) => set({ customMin: e.target.value })} aria-label="Custom window in minutes" />}
        </Field>
      </div>
      <div className={cn("text-right font-mono text-[11px]", v.errs.uri ? "text-destructive" : "text-muted-foreground")}>
        {v.errs.uri ?? `${v.bytes}/${MAX_URI} bytes on-chain`}
      </div>
    </div>
  );
}

function CreateForm() {
  const { wallet, openWallet, net } = useApp();
  const tx = useTx();
  const [d, setD] = useState<Draft>(blank);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const v = validate(d);
  const preview: Resource = useMemo(
    () => ({
      id: 0n,
      seller: wallet?.address ?? "0x0000000000000000000000000000000000000000",
      price: v.price ?? 0n,
      window: v.window > 0 ? v.window : 3600,
      active: true,
      sales: 0n,
      revenue: 0n,
      uri: v.uri,
      meta: { ...parseMeta(v.uri, 0), name: d.name.trim() || "Your API" },
    }),
    [wallet?.address, v.price, v.window, v.uri, d.name],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet) return openWallet(true);
    setTried(true);
    if (!v.ok || v.price === null) {
      // after React marks the fields invalid, move focus to the first one
      requestAnimationFrame(() => document.querySelector<HTMLElement>("#new [aria-invalid=true]")?.focus());
      return;
    }
    setBusy(true);
    try {
      await tx({ label: `List “${d.name.trim()}”`, functionName: "createResource", args: [v.price, v.window, v.uri], success: () => "It's in the market now." });
      setD(blank);
      setTried(false);
    } catch {
      /* toast explains */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="new" className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
      <form className="rounded-xl border bg-card p-6" onSubmit={submit} noValidate>
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">New listing</h2>
          <span className="text-xs text-muted-foreground">One transaction</span>
        </div>
        <TermsFields d={d} set={set} v={v} show={tried} />
        <Button type="submit" size="lg" className="mt-6 h-11 w-full rounded-xl" disabled={!net.contract || busy}>
          {busy ? <Spinner /> : wallet ? <Plus className="size-4" /> : <Wallet className="size-4" />}
          {!net.contract ? "Not deployed here" : wallet ? "List it" : "Connect wallet to list"}
        </Button>
      </form>
      <div className="space-y-3 lg:sticky lg:top-24">
        <Eyebrow>Live preview</Eyebrow>
        <Pass r={preview} until={0} preview />
        <p className="text-xs text-muted-foreground">Reprice, pause or transfer it anytime.</p>
      </div>
    </div>
  );
}

function EditDialog({ r, onClose }: { r: Resource; onClose: () => void }) {
  const tx = useTx();
  const [d, setD] = useState<Draft>(() => {
    const w = WINDOWS.some(([s]) => s === r.window) ? r.window : -1;
    return { name: r.meta.name, desc: r.meta.desc, url: r.meta.url ?? "", price: formatUnits(r.price, 18), window: w, customMin: w === -1 ? String(r.window / 60) : "" };
  });
  const [active, setActive] = useState(r.active);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const v = validate(d);
  async function save() {
    if (!v.ok || v.price === null) return;
    setBusy(true);
    try {
      await tx({ label: `Update #${r.id}`, functionName: "updateResource", args: [r.id, v.price, v.window, active, v.uri], success: () => "Saved." });
      onClose();
    } catch {
      /* toast explains */
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit #{r.id.toString()}</DialogTitle>
          <DialogDescription>Price or window changes make in-flight buys revert, never overcharge.</DialogDescription>
        </DialogHeader>
        <TermsFields d={d} set={set} v={v} show />
        <label className="flex items-center gap-3 rounded-xl border p-3 text-sm">
          <Switch checked={active} onCheckedChange={setActive} />
          {active ? "On sale" : "Paused · existing passes keep working"}
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !v.ok}>
            {busy && <Spinner />}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransferDialog({ r, onClose }: { r: Resource; onClose: () => void }) {
  const tx = useTx();
  const [to, setTo] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const ok = isAddress(to) && !sameAddr(to, r.seller);
  async function go() {
    setBusy(true);
    try {
      await tx({ label: `Transfer #${r.id}`, functionName: "transferResource", args: [r.id, getAddress(to)], success: () => "Future sales go to the new seller." });
      onClose();
    } catch {
      /* toast */
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer #{r.id.toString()}</DialogTitle>
          <DialogDescription>The new address gets future sales and control. What you've earned stays yours.</DialogDescription>
        </DialogHeader>
        <Input className="font-mono text-sm" placeholder="0x… new seller" value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={to !== "" && !ok} aria-label="New seller address" spellCheck={false} />
        <label className="flex items-start gap-3 text-sm text-muted-foreground">
          <Checkbox checked={confirm} onCheckedChange={(c) => setConfirm(c === true)} className="mt-0.5" />I trust this address. I can't undo this.
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={go} disabled={!ok || !confirm || busy}>
            {busy && <Spinner />}Transfer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WithdrawToDialog({ amount, onClose }: { amount: bigint; onClose: () => void }) {
  const tx = useTx();
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await tx({ label: `Withdraw ${usdc(amount)} USDC`, functionName: "withdrawTo", args: [getAddress(to)], success: () => `Sent to ${to.slice(0, 8)}…` });
      onClose();
    } catch {
      /* toast */
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Withdraw elsewhere</DialogTitle>
          <DialogDescription>Send all {usdc(amount)} USDC to another address.</DialogDescription>
        </DialogHeader>
        <Input className="font-mono text-sm" placeholder="0x… destination" value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={to !== "" && !isAddress(to)} aria-label="Destination" spellCheck={false} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={go} disabled={!isAddress(to) || busy}>
            {busy && <Spinner />}Withdraw
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Sell() {
  const { net, wallet, openWallet } = useApp();
  const res = useResources();
  const bal = useBalance(wallet?.address);
  const tx = useTx();
  const [edit, setEdit] = useState<Resource | null>(null);
  const [xfer, setXfer] = useState<Resource | null>(null);
  const [wTo, setWTo] = useState(false);
  const [busyW, setBusyW] = useState(false);
  const [toggling, setToggling] = useState<bigint | null>(null);
  const mine = (res.data ?? []).filter((r) => sameAddr(r.seller, wallet?.address));
  const lifetime = mine.reduce((a, r) => a + r.revenue, 0n);
  const sold = mine.reduce((a, r) => a + r.sales, 0n);

  async function withdraw() {
    setBusyW(true);
    try {
      await tx({ label: `Withdraw ${usdc(bal ?? 0n)} USDC`, functionName: "withdraw", args: [], success: () => "Sent to your wallet." });
    } catch {
      /* toast */
    } finally {
      setBusyW(false);
    }
  }

  async function toggle(r: Resource) {
    setToggling(r.id);
    try {
      await tx({ label: r.active ? `Pause #${r.id}` : `Resume #${r.id}`, functionName: "updateResource", args: [r.id, r.price, r.window, !r.active, r.uri], success: () => (r.active ? "Paused." : "Back on sale.") });
    } catch {
      /* toast */
    } finally {
      setToggling(null);
    }
  }

  const selling = !!wallet && (mine.length > 0 || (bal ?? 0n) > 0n);

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <PageHeader title="Sell access" sub="List an endpoint, set a price, collect USDC." />

      {!net.contract ? (
        <div className="space-y-8">
          <NotDeployed />
          <CreateForm />
        </div>
      ) : (
        <div className="space-y-8">
          {!wallet && (
            <div className="flex flex-col items-start gap-4 rounded-xl border p-5 sm:flex-row sm:items-center">
              <Wallet className="size-5 shrink-0 text-muted-foreground" />
              <p className="flex-1 text-sm text-muted-foreground">Connect a wallet to see your listings and earnings, or list something new below.</p>
              <Button onClick={() => openWallet(true)}>Connect wallet</Button>
            </div>
          )}

          {selling && (
            <>
              <div className="rounded-xl border bg-card">
                <dl className="grid grid-cols-3 divide-x">
                  <div className="p-4 sm:p-5">
                    <dt className="text-xs text-muted-foreground">To withdraw</dt>
                    <dd className="mt-1 font-mono text-xl font-semibold tabular-nums sm:text-2xl">{bal === null ? "…" : usdc(bal)}</dd>
                  </div>
                  <div className="p-4 sm:p-5">
                    <dt className="text-xs text-muted-foreground">Passes sold</dt>
                    <dd className="mt-1 font-mono text-xl font-semibold tabular-nums sm:text-2xl">{intFmt(sold)}</dd>
                  </div>
                  <div className="p-4 sm:p-5">
                    <dt className="text-xs text-muted-foreground">Revenue</dt>
                    <dd className="mt-1 font-mono text-xl font-semibold tabular-nums sm:text-2xl">{usdc(lifetime)}</dd>
                  </div>
                </dl>
                <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3 sm:px-5">
                  <span className="mr-auto text-xs text-muted-foreground">All amounts in USDC. No fees.</span>
                  <Button size="sm" variant="outline" onClick={() => setWTo(true)} disabled={!bal}>
                    <Send className="size-4" /> Withdraw elsewhere
                  </Button>
                  <Button size="sm" onClick={withdraw} disabled={!bal || busyW}>
                    {busyW ? <Spinner /> : <ArrowDownToLine className="size-4" />} Withdraw
                  </Button>
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border bg-card">
                <div className="border-b px-5 py-4">
                  <h2 className="font-semibold tracking-tight">Your listings</h2>
                </div>
                {mine.length === 0 ? (
                  <Empty icon={<PackageOpen />} title="No listings">
                    You moved your listings to another address. Earnings stay withdrawable.
                  </Empty>
                ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-5">Resource</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="hidden sm:table-cell">Window</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Sold</TableHead>
                      <TableHead className="hidden text-right md:table-cell">Revenue</TableHead>
                      <TableHead>Live</TableHead>
                      <TableHead className="pr-5" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mine.map((r) => (
                      <TableRow key={r.id.toString()}>
                        <TableCell className="pl-5">
                          <a href={`#/r/${r.id}`} className="font-medium hover:text-primary">
                            {r.meta.name}
                          </a>
                          <div className="font-mono text-[11px] text-muted-foreground">#{r.id.toString()}</div>
                        </TableCell>
                        <TableCell className="text-right font-mono">{usdc(r.price)}</TableCell>
                        <TableCell className="hidden sm:table-cell">{duration(r.window)}</TableCell>
                        <TableCell className="hidden text-right font-mono sm:table-cell">{intFmt(r.sales)}</TableCell>
                        <TableCell className="hidden text-right font-mono md:table-cell">{usdc(r.revenue)}</TableCell>
                        <TableCell>
                          <Switch checked={r.active} disabled={toggling === r.id} onCheckedChange={() => toggle(r)} aria-label={r.active ? "Pause" : "Resume"} />
                        </TableCell>
                        <TableCell className="pr-5 text-right">
                          <div className="flex justify-end gap-1">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon" className="size-8" onClick={() => setEdit(r)} aria-label="Edit listing">
                                  <Pencil className="size-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Edit</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon" className="size-8" onClick={() => setXfer(r)} aria-label="Transfer listing">
                                  <Send className="size-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Transfer to another seller</TooltipContent>
                            </Tooltip>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                )}
              </div>
            </>
          )}

          <CreateForm />
        </div>
      )}
      {edit && <EditDialog r={edit} onClose={() => setEdit(null)} />}
      {xfer && <TransferDialog r={xfer} onClose={() => setXfer(null)} />}
      {wTo && bal !== null && <WithdrawToDialog amount={bal} onClose={() => setWTo(false)} />}
    </div>
  );
}
