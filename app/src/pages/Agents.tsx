import type { ReactNode } from "react";
import { Code2, Coins, FileWarning, Fingerprint, MessageSquareReply } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeTabs } from "../components/CodeTabs";
import { PageHeader } from "../components/common";
import { REPO } from "../config";
import { useApp } from "../lib/store";

function Step({ n, icon: Icon, title, text, children }: { n: number; icon: typeof Coins; title: string; text: ReactNode; children: ReactNode }) {
  return (
      <section className="grid gap-5 md:grid-cols-[260px_minmax(0,1fr)]">
        <div>
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
              <Icon className="size-5" />
            </span>
            <span className="font-mono text-xs text-muted-foreground">step {n}</span>
          </div>
          <h2 className="mt-4 text-xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{text}</p>
        </div>
        <div className="min-w-0">{children}</div>
      </section>
  );
}

const FUNCS: [string, string, string][] = [
  ["quote(id)", "anyone", "Price, window, seller, on-sale, uri"],
  ["pay(id, minWindow)", "buyer", "Exact price as value; extends your pass"],
  ["payFor(id, who, minWindow)", "anyone", "Same, pass goes to another address"],
  ["hasAccess(who, id)", "server", "True while the pass is valid"],
  ["remaining(who, id)", "anyone", "Seconds left"],
  ["getResources(from, limit)", "anyone", "Paged listings, limit ≤ 25"],
  ["createResource(price, window, uri)", "seller", "List; window 1s to 365d"],
  ["updateResource(id, …)", "seller", "Reprice, pause, edit. Never revokes passes"],
  ["transferResource(id, to)", "seller", "Hand over future sales"],
  ["withdraw() / withdrawTo(to)", "seller", "Pull your USDC"],
];

const ERRORS: [string, string][] = [
  ["WrongAmount", "Value ≠ current price. Re-read the quote."],
  ["WindowTooShort", "Seller shortened the window after your quote."],
  ["Inactive", "Paused or never created."],
  ["NotSeller", "Only the seller can change a listing."],
  ["NothingToWithdraw", "No balance to pull."],
  ["TransferFailed", "Destination refused USDC; use withdrawTo."],
  ["UriTooLong · ZeroWindow · WindowTooLong · ZeroAddress", "Input validation."],
];

export function Agents() {
  const { net } = useApp();
  const c = (!net.simulated && net.contract) || "0x<PayGate>";
  const chain = net.chain.id;

  const four02 = `HTTP/1.1 402 Payment Required

{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact-native",
    "network": "eip155:${chain}",
    "maxAmountRequired": "10000000000000000",
    "payTo": "${c}",
    "extra": { "paygate": { "resource_id": 1, "window_seconds": 3600 } }
  }],
  "scheme": "paygate-native-v2",
  "contract": "${c}",
  "resource_id": 1,
  "price_usdc": "0.01",
  "window_seconds": 3600,
  "auth": {
    "message": "paygate:2:${chain}:${c.toLowerCase()}:1:5972140:api.example.com"
  }
}`;

  const retry = `GET /api/polymarket-rewards
X-PayGate-Address: 0xYourAgent
X-PayGate-Signature: 0x<personal_sign(auth.message)>

HTTP/1.1 200 OK
X-PAYMENT-RESPONSE: <base64 {"success":true,"accessUntil":1791739200}>
{ "access_until": 1791739200, "data": { … } }`;

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <PageHeader
        title="Integrate"
        sub="Three steps from 402 to 200."
        action={
          <Button asChild variant="outline" className="rounded-full">
            <a href={REPO} target="_blank" rel="noopener noreferrer">
              <Code2 className="size-4" /> Source
            </a>
          </Button>
        }
      />

      <div className="space-y-16">
        <Step n={1} icon={MessageSquareReply} title="Read the 402" text="The body names chain, contract, resource and price. Treat it as a claim and re-check on-chain.">
          <CodeTabs tabs={[{ key: "402", label: "402", plain: four02 }]} title="response" />
        </Step>

        <Step n={2} icon={Coins} title="Pay once on Arc" text={<>Call pay(id, minWindow) with value = price. 18 decimals in msg.value.</>}>
          <CodeTabs
            tabs={[
              {
                key: "viem",
                label: "viem",
                plain: `const [price, window] = await client.readContract({\n  address: "${c}", abi, functionName: "quote", args: [1n],\n});\nawait wallet.writeContract({\n  address: "${c}", abi, functionName: "pay",\n  args: [1n, window], value: price,\n});`,
              },
              {
                key: "cast",
                label: "cast",
                plain: `cast send ${c} "pay(uint256,uint32)" 1 3600 \\\n  --value 0.01ether --rpc-url ${net.walletRpc || "https://rpc.testnet.arc.io"}`,
              },
              {
                key: "py",
                label: "Python",
                plain: `python py/client.py fetch https://api.example.com/api/polymarket-rewards \\\n  --contract ${c} --max-usdc 0.05`,
              },
            ]}
          />
        </Step>

        <Step n={3} icon={Fingerprint} title="Sign and retry" text="The message binds chain, contract, resource, a 5-minute bucket and the host, so it can't be replayed elsewhere.">
          <CodeTabs tabs={[{ key: "http", label: "http", plain: retry }]} title="request → response" />
        </Step>

          <Tabs defaultValue="fns" className="rounded-xl border bg-card p-2">
            <TabsList className="m-2">
              <TabsTrigger value="fns">Functions</TabsTrigger>
              <TabsTrigger value="errs">Errors</TabsTrigger>
            </TabsList>
            <TabsContent value="fns">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Function</TableHead>
                    <TableHead>Who</TableHead>
                    <TableHead>Does</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {FUNCS.map(([f, w, d]) => (
                    <TableRow key={f}>
                      <TableCell className="font-mono text-xs">{f}</TableCell>
                      <TableCell className="text-muted-foreground">{w}</TableCell>
                      <TableCell className="whitespace-normal">{d}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>
            <TabsContent value="errs">
              <Table>
                <TableBody>
                  {ERRORS.map(([e, d]) => (
                    <TableRow key={e}>
                      <TableCell className="font-mono text-xs whitespace-normal">{e}</TableCell>
                      <TableCell className="whitespace-normal">{d}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>
          </Tabs>

        <div className="flex items-start gap-3 rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
          <FileWarning className="mt-0.5 size-4 shrink-0" />
          <p>
            A pass is a time-boxed entitlement per address. No refunds, no delivery guarantee: serving data is the seller's job. Anyone holding the key can use the pass.
          </p>
        </div>
      </div>
    </div>
  );
}
