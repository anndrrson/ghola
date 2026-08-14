#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runHyperliquidMainnetRoundTrip } from "./hyperliquid-testnet-roundtrip.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const reportPath = resolve(SCRIPT_DIR, "../../../.dev/hyperliquid-mainnet-roundtrip.json");

let report;
try {
  report = await runHyperliquidMainnetRoundTrip();
} catch (error) {
  report = {
    ok: false,
    network: "mainnet",
    error: error instanceof Error ? error.message : String(error),
    completed_at: new Date().toISOString(),
  };
}

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`GHOLA_MAINNET_ROUNDTRIP_RESULT=${JSON.stringify(report)}\n`);
if (!report.ok) process.exitCode = 1;
