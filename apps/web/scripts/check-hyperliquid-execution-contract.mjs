#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function checkHyperliquidExecutionContract({ component, lifecycle, server, verifier }) {
  const failures = [];
  const requireText = (source, value, code) => {
    if (!source.includes(value)) failures.push(code);
  };
  const forbidText = (source, value, code) => {
    if (source.includes(value)) failures.push(code);
  };
  const publicOrder = sliceBetween(component, "const manualPerpOrder", "const perpOrder");
  const closeOrder = sliceBetween(lifecycle, "export function buildHyperliquidReduceOnlyClose", "export function hyperliquidAccountIsFlatAndClear");

  requireText(publicOrder, 'order_type: "market"', "public_market_order_required");
  requireText(publicOrder, 'tif: "Ioc"', "public_ioc_required");
  forbidText(publicOrder, 'live_order_mode: "tiny_fill"', "public_order_misrouted_to_tiny_fill");
  requireText(closeOrder, "live_order_mode: undefined", "close_full_ticket_route_required");
  forbidText(verifier, 'live_order_mode: "tiny_fill"', "release_verifier_misrouted_to_tiny_fill");
  requireText(verifier, 'order_type: "market"', "release_verifier_market_order_required");
  requireText(server, 'submitted.error === "connector_submit_failed"', "worker_failure_lock_required");

  if (failures.length) {
    throw new Error(`Hyperliquid execution contract failed: ${failures.join(", ")}`);
  }
  return { ok: true };
}

function sliceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  return startIndex >= 0 && endIndex > startIndex ? source.slice(startIndex, endIndex) : "";
}

function main() {
  const src = resolve(HERE, "../src");
  checkHyperliquidExecutionContract({
    component: readFileSync(resolve(src, "components/trade/PublicCoinbaseLiveTrade.tsx"), "utf8"),
    lifecycle: readFileSync(resolve(src, "lib/hyperliquid-trade-lifecycle.ts"), "utf8"),
    server: readFileSync(resolve(src, "app/v1/private-account/_lib.ts"), "utf8"),
    verifier: readFileSync(resolve(HERE, "verify-prod-hyperliquid.mjs"), "utf8"),
  });
  console.log("[hyperliquid-execution-contract] verified");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
