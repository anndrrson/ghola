import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkHyperliquidExecutionContract } from "./check-hyperliquid-execution-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../src");
const sources = {
  component: readFileSync(resolve(SRC, "components/trade/PublicCoinbaseLiveTrade.tsx"), "utf8"),
  lifecycle: readFileSync(resolve(SRC, "lib/hyperliquid-trade-lifecycle.ts"), "utf8"),
  phala: readFileSync(resolve(SRC, "lib/private-agent-phala.ts"), "utf8"),
  server: readFileSync(resolve(SRC, "app/v1/private-account/_lib.ts"), "utf8"),
  verifier: readFileSync(resolve(HERE, "verify-prod-hyperliquid.mjs"), "utf8"),
};

test("accepts the full-ticket $11 Hyperliquid contract", () => {
  assert.equal(checkHyperliquidExecutionContract(sources).ok, true);
});

test("rejects release validation without Phala runtime-mode parity", () => {
  const changed = {
    ...sources,
    phala: sources.phala
      .replaceAll("phalaWorkerRuntimeConfigDrift", "removedRuntimeConfigDrift")
      .replaceAll("runtime_config_matches_requested_mode", "removed_runtime_config_gate"),
  };
  assert.throws(
    () => checkHyperliquidExecutionContract(changed),
    /phala_runtime_config_parity_required|phala_runtime_config_gate_required/,
  );
});

test("rejects routing the public ticket back through the $5 tiny-fill cap", () => {
  const changed = {
    ...sources,
    component: sources.component.replaceAll(
      'order_type: "market",',
      'order_type: "market",\n    live_order_mode: "tiny_fill",',
    ),
  };
  assert.throws(
    () => checkHyperliquidExecutionContract(changed),
    /public_order_misrouted_to_tiny_fill/,
  );
});
