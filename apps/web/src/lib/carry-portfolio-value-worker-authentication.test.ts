import { createHash, generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import {
  canonicalCarryCommitmentJson,
  carryPortfolioValueAuthenticationMessage,
} from "@ghola/execution-core";
import { describe, expect, it } from "vitest";
import { verifyCarryPortfolioValueWorkerAuthentication } from "./carry-portfolio-value-worker-authentication";

const NOW = 1_800_000_000_000;
const SIGNER = generateKeyPairSync("ed25519");
const SIGNER_PUBLIC_KEY_B64 = SIGNER.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const ROUTE = "/carry/positions/value-report";
const BODY = {
  owner_commitment: "owner_commitment_0001",
  owner_capital_budget_micro_usdc: 0,
  max_data_age_ms: 30_000,
  minimum_transfer_arrival_buffer_ms: 300_000,
};

describe("Carry portfolio-value worker authentication", () => {
  it("accepts only the exact fresh report and owner-scoped request signed by the pinned worker", () => {
    expect(verify(response())).toEqual({ ok: true });
    const changedReport = response();
    changedReport.report = { ...changedReport.report, finalized_position_count: 2 };
    expect(verify(changedReport).ok).toBe(false);
    expect(verify(response(), { body: { ...BODY, owner_commitment: "owner_commitment_other" } }).ok).toBe(false);
    expect(verify(response(), { now_ms: NOW + 30_000 }).ok).toBe(false);
    expect(verify(response(), {
      env: { NODE_ENV: "production", GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: "wrong-pin" },
    }).ok).toBe(false);
  });
});

function verify(value: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return verifyCarryPortfolioValueWorkerAuthentication({
    route_path: ROUTE,
    body: BODY,
    response: value,
    now_ms: NOW + 1,
    env: { NODE_ENV: "production", GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: SIGNER_PUBLIC_KEY_B64 },
    ...overrides,
  });
}

function response() {
  const report = {
    version: 1,
    kind: "ghola_carry_portfolio_value_report",
    checked_at_ms: NOW,
    value_proof_status: "finalized",
    finalized_position_count: 1,
    finalized_after_costs: { net_value_micro_usdc: 19_500_000 },
  };
  const reportCommitment = `carry:portfolio-value-report:${createHash("sha256")
    .update(canonicalCarryCommitmentJson(report))
    .digest("hex")}`;
  const context = {
    route_path: ROUTE,
    ...BODY,
    report_commitment: reportCommitment,
    checked_at_ms: NOW,
    expires_at_ms: NOW + 30_000,
  };
  const message = carryPortfolioValueAuthenticationMessage(context);
  return {
    ok: true,
    report,
    worker_authentication: {
      version: 1,
      algorithm: "ed25519",
      attestation_bound: true,
      request_bound: true,
      report_replay_bound: true,
      signature_b64: signEd25519(null, Buffer.from(message), SIGNER.privateKey).toString("base64"),
      signer_public_key_b64: SIGNER_PUBLIC_KEY_B64,
      context,
    },
  };
}
