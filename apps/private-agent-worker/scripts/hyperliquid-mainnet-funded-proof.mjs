#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyHyperliquidMainnetVenueEvidence } from "../src/execution/hyperliquid-mainnet-evidence.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const DEFAULT_SOURCE = resolve(REPO_ROOT, ".dev/hyperliquid-mainnet-hardened-roundtrip.json");
const OUTPUT = resolve(REPO_ROOT, ".dev/hyperliquid-mainnet-funded-proof.json");
const SOURCE_FILES = [
  "apps/private-agent-worker/scripts/hyperliquid-mainnet-hardened-roundtrip.mjs",
  "apps/private-agent-worker/src/execution/hyperliquid-mainnet-evidence.js",
  "apps/private-agent-worker/src/execution/hyperliquid-mainnet-roundtrip.js",
  "apps/private-agent-worker/src/execution/hyperliquid-mainnet-protection.js",
  "apps/private-agent-worker/src/execution/private-execution.js",
  "apps/private-agent-worker/src/execution/policy.js",
  "apps/private-agent-worker/src/venues/hyperliquid.js",
  "apps/private-agent-worker/src/venues/hyperliquid_runner.py",
  "apps/private-agent-worker/src/server.js",
  "apps/web/src/app/v1/private-account/_lib.ts",
];

export function fundedProofConfig(env = process.env, sourceArg = null) {
  const accountAddress = String(env.GHOLA_HYPERLIQUID_MAINNET_ACCOUNT_ADDRESS || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/u.test(accountAddress)) throw new Error("mainnet account address is required");
  const sourcePath = resolve(sourceArg || env.GHOLA_MAINNET_HARDENED_REPORT_PATH || DEFAULT_SOURCE);
  return { accountAddress, sourcePath };
}

export async function createFundedProofDossier({
  env = process.env,
  sourceArg = null,
  fetchImpl = fetch,
} = {}) {
  const config = fundedProofConfig(env, sourceArg);
  const sourceBytes = readFileSync(config.sourcePath);
  const report = JSON.parse(sourceBytes.toString("utf8"));
  assertHardenedReport(report);
  const freshEvidence = await verifyHyperliquidMainnetVenueEvidence({
    baseUrl: "https://api.hyperliquid.xyz",
    accountAddress: config.accountAddress,
    market: "HYPE",
    entry: report.entry_order_reference,
    exit: report.exit_order_reference,
    protection: {
      take_profit: { oid: report.take_profit_oid, cloid: report.take_profit_cloid },
      stop_loss: { oid: report.stop_loss_oid, cloid: report.stop_loss_cloid },
    },
    expectedNotionalUsd: 10.5,
    fetchImpl,
  });
  assertSameVenueEvidence(report.venue_evidence, freshEvidence);
  const sourceFiles = Object.fromEntries(SOURCE_FILES.map((path) => [
    path,
    `sha256:${sha256(readFileSync(resolve(REPO_ROOT, path)))}`,
  ]));
  const sourceCommitment = `sha256:${sha256(canonicalJson(sourceFiles))}`;
  const totalFees = roundMoney(
    Number(freshEvidence.entry.fee_usd) + Number(freshEvidence.exit.fee_usd),
  );
  const grossPnl = roundMoney(
    Number(freshEvidence.exit.filled_notional_usd) - Number(freshEvidence.entry.filled_notional_usd),
  );
  const dossier = {
    version: 1,
    status: "funded_production_proven",
    scope: "local_hardened_worker_to_hyperliquid_mainnet",
    network: "mainnet",
    venue: "hyperliquid",
    market: "HYPE",
    real_funds: true,
    execution_account_address: config.accountAddress,
    notional_usd: 10.5,
    entry_order: freshEvidence.entry,
    exit_order: freshEvidence.exit,
    round_trip: {
      independently_requeried: true,
      entry_before_exit: true,
      entry_exit_sizes_match: true,
      reduce_only_exit_proven: true,
      flat_after_exit: true,
      open_orders_after_exit: 0,
      total_fees_usdc: totalFees,
      gross_pnl_usdc: grossPnl,
      net_pnl_after_fees_usdc: roundMoney(grossPnl - totalFees),
      exposure_window_ms: freshEvidence.exit.first_fill_time_ms - freshEvidence.entry.first_fill_time_ms,
    },
    safety_proof: {
      real_no_submit_preflight: report.preflight_verified === true &&
        report.preflight_transaction_broadcast === false,
      reduce_only_exit_no_submit_preflight: report.exit_preflight_verified === true &&
        report.exit_preflight_transaction_broadcast === false,
      trade_only_api_wallet_authorized: report.api_wallet_authorization_verified === true,
      api_wallet_address: report.api_wallet_address,
      api_wallet_valid_until: report.api_wallet_valid_until,
      isolated_margin: report.default_margin_mode === "isolated",
      leverage: report.default_leverage,
      durable_claim_store: report.claim_store,
      duplicate_entry_prevented: report.duplicate_entry_prevented,
      duplicate_exit_prevented: report.duplicate_exit_prevented,
      stored_receipt_replayed: report.stored_receipt_replayed,
      venue_native_position_protection: report.venue_position_protection_proven,
      protection_cleanup_confirmed: report.protection_cleanup_confirmed,
      protection_children_terminal: freshEvidence.protection_children_terminal,
    },
    source_report: {
      path: config.sourcePath,
      sha256: `sha256:${sha256(sourceBytes)}`,
      proof_work_order_commitment: report.proof_work_order_commitment,
      venue_evidence_commitment: report.venue_evidence_commitment,
      completed_at: report.completed_at,
    },
    code_identity: {
      git_head: git(["rev-parse", "HEAD"]),
      worktree_dirty: git(["status", "--porcelain=v1"]).length > 0,
      relevant_source_commitment: sourceCommitment,
      source_files: sourceFiles,
    },
    cost_guard: {
      paid_runtime_calls: 0,
      phala_contacted: false,
      render_contacted: false,
      funded_round_trips: 1,
    },
    limitations: [
      "Proves one bounded HYPE mainnet round trip on one funded account.",
      "Does not prove every market, venue, account, or long-duration runtime condition.",
      "Does not prove that the current local code has been deployed to ghola.xyz.",
    ],
    independently_verified_at: freshEvidence.verified_at,
  };
  return dossier;
}

function assertHardenedReport(report) {
  if (report?.ok !== true || report?.status !== "filled" || report?.network !== "mainnet" ||
      report?.market !== "HYPE" || report?.notional_usd !== 10.5 || report?.claim_store !== "postgres" ||
      report?.preflight_verified !== true || report?.api_wallet_authorization_verified !== true ||
      !/^0x[0-9a-f]{40}$/u.test(String(report?.api_wallet_address || "").toLowerCase()) ||
      report?.preflight_transaction_broadcast !== false || report?.independent_venue_evidence_proven !== true ||
      report?.exit_preflight_verified !== true || report?.exit_preflight_transaction_broadcast !== false ||
      report?.final_proof?.exit_preflight_proven !== true ||
      report?.venue_position_protection_proven !== true ||
      report?.protection_cleanup_confirmed !== true || report?.protection_children_terminal !== true ||
      !/^\d+$/u.test(String(report?.take_profit_oid || "")) ||
      !/^\d+$/u.test(String(report?.stop_loss_oid || "")) ||
      !/^0x[0-9a-f]{32}$/u.test(String(report?.take_profit_cloid || "").toLowerCase()) ||
      !/^0x[0-9a-f]{32}$/u.test(String(report?.stop_loss_cloid || "").toLowerCase()) ||
      report?.flat_after_exit !== true || report?.open_orders_after_exit !== 0 ||
      !/^sha256:[0-9a-f]{64}$/u.test(String(report?.venue_evidence_commitment || ""))) {
    throw new Error("source report is not a hardened funded-mainnet proof");
  }
}

function assertSameVenueEvidence(first, second) {
  for (const phase of ["entry", "exit"]) {
    const left = first?.[phase];
    const right = second?.[phase];
    if (String(left?.oid) !== String(right?.oid) ||
        String(left?.cloid).toLowerCase() !== String(right?.cloid).toLowerCase() ||
        String(left?.filled_base_size) !== String(right?.filled_base_size) ||
        canonicalJson(left?.transaction_hashes) !== canonicalJson(right?.transaction_hashes)) {
      throw new Error(`fresh Hyperliquid ${phase} evidence differs from the worker proof`);
    }
  }
  for (const phase of ["take_profit", "stop_loss"]) {
    const left = first?.protection?.[phase];
    const right = second?.protection?.[phase];
    if (String(left?.oid) !== String(right?.oid) ||
        String(left?.cloid).toLowerCase() !== String(right?.cloid).toLowerCase() ||
        left?.order_status !== "canceled" || right?.order_status !== "canceled") {
      throw new Error(`fresh Hyperliquid ${phase} protection evidence differs from the worker proof`);
    }
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function roundMoney(value) {
  return Math.round(Number(value) * 1e8) / 1e8;
}

async function main() {
  let dossier;
  try {
    dossier = await createFundedProofDossier({ sourceArg: process.argv[2] || null });
  } catch (error) {
    dossier = {
      version: 1,
      status: "unproven",
      error: error instanceof Error ? error.message : String(error),
      independently_verified_at: new Date().toISOString(),
    };
  }
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(dossier, null, 2)}\n`, { mode: 0o600 });
  chmodSync(OUTPUT, 0o600);
  process.stdout.write(`${JSON.stringify(dossier, null, 2)}\n`);
  if (dossier.status !== "funded_production_proven") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
