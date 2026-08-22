import { afterEach, describe, expect, it } from "vitest";
import {
  publicReviewProofKey,
  signPublicPrivateAgentDemoRun,
  verifyPublicPrivateAgentDemoToken,
} from "./private-account-demo-receipt";
import type { PublicPrivateAgentDemoRun } from "./private-account-demo";

const ENV = {
  GHOLA_REVIEW_PROOF_SIGNING_KEY_B64: Buffer.alloc(32, 7).toString("base64url"),
  GHOLA_PUBLIC_ORIGIN: "https://review.ghola.test",
};

describe("private-agent exact review receipts", () => {
  afterEach(() => {
    delete process.env.GHOLA_REVIEW_PROOF_SIGNING_KEY_B64;
    delete process.env.GHOLA_REVIEW_PROOF_SIGNER_DID;
    delete process.env.GHOLA_PUBLIC_ORIGIN;
  });

  it("binds the exact no-submit receipt to an Ed25519 signature and verifier URL", () => {
    const receipt = reviewReceipt();
    const signed = signPublicPrivateAgentDemoRun(receipt, ENV);

    expect(signed.status).toBe("signed_exact_receipt");
    if (signed.status !== "signed_exact_receipt") throw new Error("signing failed");
    expect(signed.verification_url).toContain(
      "https://review.ghola.test/v1/private-account/demo/verify?token=",
    );
    expect(signed.public_key_url).toBe(
      "https://review.ghola.test/v1/private-account/demo/verification-key",
    );
    expect(signed.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.token.length).toBeLessThan(8_000);

    const verified = verifyPublicPrivateAgentDemoToken(signed.token, ENV);
    expect(verified.valid).toBe(true);
    if (!verified.valid) throw new Error(verified.reason_code);
    expect(verified.signature_valid).toBe(true);
    expect(verified.receipt_hash_matches).toBe(true);
    expect(verified.receipt.execution_ticket.ticket_id).toBe("demo_exact_ticket");
    expect(verified.receipt.execution_ticket.result_commitment).toBe(
      "public_demo_result_exact",
    );
  });

  it("rejects a changed receipt even when the original signature is retained", () => {
    const signed = signPublicPrivateAgentDemoRun(reviewReceipt(), ENV);
    if (signed.status !== "signed_exact_receipt") throw new Error("signing failed");
    const [header, payload, signature] = signed.token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    decoded.receipt.broadcast = true;
    const tamperedPayload = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");

    expect(verifyPublicPrivateAgentDemoToken(
      `${header}.${tamperedPayload}.${signature}`,
      ENV,
    )).toMatchObject({
      valid: false,
      signature_valid: false,
      reason_code: "review_proof_signature_invalid",
    });
  });

  it("rejects a valid signature from an untrusted key", () => {
    const attackerEnv = {
      ...ENV,
      GHOLA_REVIEW_PROOF_SIGNING_KEY_B64: Buffer.alloc(32, 9).toString("base64url"),
    };
    const attackerSigned = signPublicPrivateAgentDemoRun(reviewReceipt(), attackerEnv);
    if (attackerSigned.status !== "signed_exact_receipt") throw new Error("signing failed");

    expect(verifyPublicPrivateAgentDemoToken(attackerSigned.token, ENV)).toMatchObject({
      valid: false,
      signature_valid: false,
      reason_code: "review_proof_signer_mismatch",
    });
  });

  it("refuses to sign a receipt that violates the no-submit boundary", () => {
    const unsafe = reviewReceipt();
    (unsafe as unknown as { broadcast: boolean }).broadcast = true;

    expect(signPublicPrivateAgentDemoRun(unsafe, ENV)).toMatchObject({
      status: "unavailable",
      reason_code: "review_proof_no_submit_invariant_failed",
    });
  });

  it("refuses to claim cryptographic verification when no dedicated key is configured", () => {
    expect(signPublicPrivateAgentDemoRun(reviewReceipt(), {})).toEqual({
      version: 1,
      status: "unavailable",
      reason_code: "review_proof_signing_key_missing",
      scope: "exact_no_submit_receipt_integrity",
    });
    expect(publicReviewProofKey({})).toMatchObject({
      configured: false,
      reason_code: "review_proof_signing_key_missing",
    });
  });

  it("publishes the same trusted signer identity used to verify receipts", () => {
    const key = publicReviewProofKey(ENV);
    const signed = signPublicPrivateAgentDemoRun(reviewReceipt(), ENV);
    if (!key.configured || signed.status !== "signed_exact_receipt") {
      throw new Error("test key missing");
    }
    expect(key.signer_did).toBe(signed.signer_did);
    expect(Buffer.from(key.public_key_b64url, "base64url")).toHaveLength(32);
  });

  it("fails closed when an operator pin does not match the dedicated signing key", () => {
    const mismatched = {
      ...ENV,
      GHOLA_REVIEW_PROOF_SIGNER_DID: "did:key:zWrongReviewSigner",
    };

    expect(publicReviewProofKey(mismatched)).toMatchObject({
      configured: false,
      reason_code: "review_proof_signer_did_mismatch",
    });
    expect(signPublicPrivateAgentDemoRun(reviewReceipt(), mismatched)).toMatchObject({
      status: "unavailable",
      reason_code: "review_proof_signer_did_mismatch",
    });

    const signed = signPublicPrivateAgentDemoRun(reviewReceipt(), ENV);
    if (signed.status !== "signed_exact_receipt") throw new Error("signing failed");
    expect(verifyPublicPrivateAgentDemoToken(signed.token, mismatched)).toMatchObject({
      valid: false,
      reason_code: "review_proof_signer_did_mismatch",
    });
  });
});

function reviewReceipt(): PublicPrivateAgentDemoRun {
  return {
    version: 1,
    checked_at: "2026-08-06T12:00:00.000Z",
    status: "verified_no_submit_structural",
    demo_run_id: "demo_exact_ticket",
    execution_mode: "public_no_submit",
    wallet_required: false,
    deposit_required: false,
    broadcast: false,
    scenario: {
      scenario_id: "btc_momentum",
      venue_id: "phoenix",
      market_id: "BTC-USD",
      notional_bucket: "100",
      max_slippage_bps: 50,
    },
    execution_ticket: {
      version: 1,
      ticket_id: "demo_exact_ticket",
      policy_commitment: "public_demo_policy_exact",
      private_intent_commitment: "public_demo_private_intent_exact",
      strategy_commitment: "public_demo_strategy_exact",
      sealed_envelope_commitment: "public_demo_sealed_envelope_exact",
      work_order_commitment: "public_demo_work_order_exact",
      attestation_commitment: "public_demo_attestation_exact",
      result_commitment: "public_demo_result_exact",
      expires_at: "2026-08-06T12:10:00.000Z",
    },
    proof_chain: [
      { step: "policy_checked", commitment: "public_demo_policy_exact" },
      { step: "no_submit_result_committed", commitment: "public_demo_result_exact" },
    ],
    worker: {
      endpoint_configured: true,
      endpoint_url_commitment: "public_demo_worker_endpoint_exact",
      reachable: true,
      ready: true,
      attested_ready: true,
      provider: "phala",
      tee_kind: "phala",
      recipient_id: "phala:review",
      recipient_commitment: "public_demo_worker_recipient_exact",
      image_digest_commitment: "public_demo_worker_image_exact",
      report_data_commitment: "public_demo_worker_report_data_exact",
      quote_hash_commitment: "public_demo_worker_quote_exact",
      reason_codes: [],
    },
    venue_gate: {
      venue_id: "phoenix",
      status: "ready",
      ready: true,
      reason_codes: [],
    },
    live_submit: {
      status: "gated",
      public_no_wallet_submit: false,
      reason_codes: ["review_no_submit"],
      ready_venues: ["phoenix"],
      blocked_venues: ["hyperliquid", "jupiter", "coinbase"],
    },
    visibility_summary: {
      public_view: ["commitment_only_execution_ticket", "no_submit_result"],
      ghola_operator_view: "commitments_and_ciphertexts_only",
      worker_view: "sealed_instruction_after_recipient_unseal",
      venue_view: "none_no_order_submitted",
      chain_view: "none_no_transaction_broadcast",
    },
    disclosure: "No wallet, deposit, order, or broadcast was used.",
  };
}
