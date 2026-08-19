#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  sanitizeFundedMainnetProofReport,
  sanitizeHyperliquidCloseReport,
  verifyInvestorCanaryAcceptance,
} from "./investor-canary-acceptance-lib.mjs";

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--sanitize-proof" && argv.length === 2) {
    try {
      const report = JSON.parse(await readFile(resolve(argv[1]), "utf8"));
      process.stdout.write(`${JSON.stringify(sanitizeFundedMainnetProofReport(report), null, 2)}\n`);
      return 0;
    } catch {
      process.stderr.write("Proof sanitization: FAIL (invalid_or_incomplete_report)\n");
      return 1;
    }
  }
  if (argv[0] === "--sanitize-close" && argv.length === 2) {
    try {
      const report = JSON.parse(await readFile(resolve(argv[1]), "utf8"));
      process.stdout.write(`${JSON.stringify(sanitizeHyperliquidCloseReport(report), null, 2)}\n`);
      return 0;
    } catch {
      process.stderr.write("Close sanitization: FAIL (invalid_or_incomplete_report)\n");
      return 1;
    }
  }
  const [dossierPath, ...rest] = argv;
  if (!dossierPath || rest.length > 0 || dossierPath === "--help" || dossierPath === "-h") {
    process.stdout.write([
      "Usage:",
      "  node scripts/investor-canary-acceptance.mjs <sanitized-dossier.json>  # validation only; never GO",
      "  node scripts/investor-canary-acceptance.mjs --sanitize-proof <funded-proof-report.json>",
      "  node scripts/investor-canary-acceptance.mjs --sanitize-close <position-close-report.json>",
      "",
    ].join("\n"));
    return dossierPath === "--help" || dossierPath === "-h" ? 0 : 2;
  }

  let dossier;
  try {
    dossier = JSON.parse(await readFile(resolve(dossierPath), "utf8"));
  } catch {
    process.stderr.write("Investor canary acceptance: NO-GO\n- dossier_read: FAIL (unreadable_or_invalid_json)\n");
    return 1;
  }

  const report = verifyInvestorCanaryAcceptance(dossier);
  process.stdout.write(`Investor canary acceptance: NO-GO\n`);
  for (const item of report.checks) {
    process.stdout.write(`- ${item.id}: ${item.ok ? "PASS" : `FAIL (${item.failure})`}\n`);
  }
  if (report.release_commitment) process.stdout.write(`Release commitment: ${report.release_commitment}\n`);
  if (report.dossier_commitment) process.stdout.write(`Dossier commitment: ${report.dossier_commitment}\n`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
