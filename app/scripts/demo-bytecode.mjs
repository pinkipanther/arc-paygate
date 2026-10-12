// Writes src/demo/bytecode.ts from the forge artifact so the Demo network runs the current contract.
// Usage (from app/): forge build --root .. && npm run demo:bytecode
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const art = JSON.parse(readFileSync(new URL("out/PayGate.sol/PayGate.json", root), "utf8"));
const sha = createHash("sha256").update(readFileSync(new URL("src/PayGate.sol", root))).digest("hex");
writeFileSync(
  new URL("../src/demo/bytecode.ts", import.meta.url),
  "// Creation bytecode of src/PayGate.sol (solc 0.8.26, optimizer 200 runs), the same build the tests run against.\n" +
    "// Regenerate after changing the contract: `forge build && npm run demo:bytecode` (from app/).\n" +
    `export const PAYGATE_SOURCE_SHA256 = "${sha}";\n` +
    `export const PAYGATE_BYTECODE = "${art.bytecode.object}" as const;\n`,
);
console.log(`bytecode.ts written (${art.bytecode.object.length / 2 - 1} bytes, source sha256 ${sha.slice(0, 12)}…)`);
