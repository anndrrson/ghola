import { createHash } from "node:crypto";
import {
  canonicalCarryCommitmentJson,
  carryPortfolioValueAuthenticationMessage,
} from "@ghola/execution-core";
import { signAttestedWorkerMessage } from "../venues/shielded_funding_attestation.js";

const PROOF_LIFETIME_MS = 30_000;

export function authenticateCarryPortfolioValueReport({
  route_path: routePath,
  body,
  report,
  sign_attested_message: signAttestedMessage = signAttestedWorkerMessage,
}) {
  const checkedAtMs = report?.checked_at_ms;
  if (!Number.isSafeInteger(checkedAtMs)) throw new Error("carry_portfolio_value_authentication_timestamp_invalid");
  const expiresAtMs = checkedAtMs + PROOF_LIFETIME_MS;
  const reportCommitment = portfolioValueReportCommitment(report);
  const context = Object.freeze({
    route_path: routePath,
    owner_commitment: body?.owner_commitment,
    owner_capital_budget_micro_usdc: body?.owner_capital_budget_micro_usdc,
    max_data_age_ms: body?.max_data_age_ms,
    minimum_transfer_arrival_buffer_ms: body?.minimum_transfer_arrival_buffer_ms,
    report_commitment: reportCommitment,
    checked_at_ms: checkedAtMs,
    expires_at_ms: expiresAtMs,
  });
  const message = carryPortfolioValueAuthenticationMessage(context);
  const signature = signAttestedMessage(Buffer.from(message, "utf8"));
  return Object.freeze({
    version: 1,
    algorithm: "ed25519",
    attestation_bound: true,
    request_bound: true,
    report_replay_bound: true,
    signature_b64: signature.signature_b64,
    signer_public_key_b64: signature.signer_public_key_b64,
    context,
  });
}

export function portfolioValueReportCommitment(report) {
  return `carry:portfolio-value-report:${createHash("sha256")
    .update(canonicalCarryCommitmentJson(report))
    .digest("hex")}`;
}
