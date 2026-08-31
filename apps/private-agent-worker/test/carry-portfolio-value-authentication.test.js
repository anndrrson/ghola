import assert from "node:assert/strict";
import test from "node:test";
import {
  generateKeyPairSync,
  sign as signEd25519,
  verify as verifyEd25519,
} from "node:crypto";
import { carryPortfolioValueAuthenticationMessage } from "@ghola/execution-core";
import {
  authenticateCarryPortfolioValueReport,
  portfolioValueReportCommitment,
} from "../src/execution/carry-portfolio-value-authentication.js";

const NOW = 1_800_000_000_000;

test("attests the exact replayed portfolio report and owner-scoped request", () => {
  const signer = generateKeyPairSync("ed25519");
  const report = {
    version: 1,
    kind: "ghola_carry_portfolio_value_report",
    checked_at_ms: NOW,
    value_proof_status: "finalized",
    finalized_after_costs: { net_value_micro_usdc: 19_500_000 },
  };
  const body = {
    owner_commitment: "owner_commitment_0001",
    owner_capital_budget_micro_usdc: 0,
    max_data_age_ms: 30_000,
    minimum_transfer_arrival_buffer_ms: 300_000,
  };
  const proof = authenticateCarryPortfolioValueReport({
    route_path: "/carry/positions/value-report",
    body,
    report,
    sign_attested_message: (message) => ({
      signature_b64: signEd25519(null, message, signer.privateKey).toString("base64"),
      signer_public_key_b64: signer.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    }),
  });
  const message = carryPortfolioValueAuthenticationMessage({
    route_path: "/carry/positions/value-report",
    ...body,
    report_commitment: portfolioValueReportCommitment(report),
    checked_at_ms: NOW,
    expires_at_ms: NOW + 30_000,
  });
  assert.equal(proof.context.report_commitment, portfolioValueReportCommitment(report));
  assert.equal(proof.report_replay_bound, true);
  assert.equal(
    verifyEd25519(null, Buffer.from(message), signer.publicKey, Buffer.from(proof.signature_b64, "base64")),
    true,
  );
  assert.notEqual(
    portfolioValueReportCommitment({ ...report, finalized_after_costs: { net_value_micro_usdc: 20_000_000 } }),
    proof.context.report_commitment,
  );
});
