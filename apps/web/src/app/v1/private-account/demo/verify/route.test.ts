import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signPublicPrivateAgentDemoRun } from "@/lib/private-account-demo-receipt";
import type { PublicPrivateAgentDemoRun } from "@/lib/private-account-demo";
import { GET as verifyReceipt } from "./route";
import { GET as getVerificationKey } from "../verification-key/route";

const ORIGINAL_ENV = { ...process.env };

describe("public exact review receipt routes", () => {
  beforeEach(() => {
    process.env.GHOLA_REVIEW_PROOF_SIGNING_KEY_B64 = Buffer.alloc(32, 11).toString("base64url");
    process.env.GHOLA_PUBLIC_ORIGIN = "https://ghola.xyz";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("verifies the same ticket and hash returned by the signer", async () => {
    const signed = signPublicPrivateAgentDemoRun(receipt());
    if (signed.status !== "signed_exact_receipt") throw new Error("signing failed");

    const response = await verifyReceipt(new Request(signed.verification_url));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      valid: true,
      signature_valid: true,
      receipt_hash_matches: true,
      receipt_sha256: signed.receipt_sha256,
      receipt: {
        demo_run_id: "demo_route_exact",
        execution_ticket: { ticket_id: "demo_route_exact" },
      },
    });
  });

  it("publishes the trusted key identity used by the verifier", async () => {
    const signed = signPublicPrivateAgentDemoRun(receipt());
    if (signed.status !== "signed_exact_receipt") throw new Error("signing failed");

    const response = await getVerificationKey();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(body).toMatchObject({
      configured: true,
      algorithm: "Ed25519",
      signer_did: signed.signer_did,
      purpose: "ghola_private_agent_exact_review_receipt",
    });
  });

  it("renders a calm human verifier without changing the machine JSON contract", async () => {
    const signed = signPublicPrivateAgentDemoRun(receipt());
    if (signed.status !== "signed_exact_receipt") throw new Error("signing failed");
    const response = await verifyReceipt(new Request(signed.verification_url, {
      headers: { accept: "text/html,application/xhtml+xml" },
    }));
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page).toContain("Exact receipt verified");
    expect(page).toContain("demo_route_exact");
    expect(page).toContain("Wallet required");
    expect(page).toContain("Ready and attested when observed");
    expect(page).not.toContain("<script");
  });

  it("returns an explicit invalid result for a changed token", async () => {
    const signed = signPublicPrivateAgentDemoRun(receipt());
    if (signed.status !== "signed_exact_receipt") throw new Error("signing failed");
    const changed = `${signed.token.slice(0, -1)}${signed.token.endsWith("A") ? "B" : "A"}`;

    const response = await verifyReceipt(new Request(
      `https://ghola.xyz/v1/private-account/demo/verify?token=${encodeURIComponent(changed)}`,
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.signature_valid).toBe(false);
    expect(body.reason_code).toBe("review_proof_signature_invalid");
  });

  it("fails closed when the verifier key is unavailable", async () => {
    delete process.env.GHOLA_REVIEW_PROOF_SIGNING_KEY_B64;

    const response = await verifyReceipt(new Request(
      "https://ghola.xyz/v1/private-account/demo/verify?token=a.b.c",
    ));
    const keyResponse = await getVerificationKey();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      valid: false,
      reason_code: "review_proof_signing_key_missing",
    });
    expect(keyResponse.status).toBe(503);
    expect(keyResponse.headers.get("cache-control")).toBe("no-store");
    await expect(keyResponse.json()).resolves.toMatchObject({
      configured: false,
      reason_code: "review_proof_signing_key_missing",
    });
  });

  it("fails closed when the configured public signer pin differs from the signing key", async () => {
    process.env.GHOLA_REVIEW_PROOF_SIGNER_DID = "did:key:zWrongReviewSigner";

    const response = await verifyReceipt(new Request(
      "https://ghola.xyz/v1/private-account/demo/verify?token=a.b.c",
    ));
    const keyResponse = await getVerificationKey();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      valid: false,
      reason_code: "review_proof_signer_did_mismatch",
    });
    expect(keyResponse.status).toBe(503);
    await expect(keyResponse.json()).resolves.toMatchObject({
      configured: false,
      reason_code: "review_proof_signer_did_mismatch",
    });
  });

  it("requires an exact token instead of generating a fresh receipt", async () => {
    const response = await verifyReceipt(new Request(
      "https://ghola.xyz/v1/private-account/demo/verify",
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      valid: false,
      reason_code: "review_proof_token_required",
    });
  });
});

function receipt(): PublicPrivateAgentDemoRun {
  return {
    version: 1,
    checked_at: "2026-08-06T12:00:00.000Z",
    status: "verified_no_submit_structural",
    demo_run_id: "demo_route_exact",
    execution_mode: "public_no_submit",
    wallet_required: false,
    deposit_required: false,
    broadcast: false,
    scenario: {
      scenario_id: "btc_momentum",
      venue_id: "phoenix",
      market_id: "BTC-USD",
      notional_bucket: "25",
      max_slippage_bps: 50,
    },
    execution_ticket: {
      version: 1,
      ticket_id: "demo_route_exact",
      policy_commitment: "public_demo_policy_route",
      private_intent_commitment: "public_demo_private_intent_route",
      strategy_commitment: "public_demo_strategy_route",
      sealed_envelope_commitment: "public_demo_sealed_envelope_route",
      work_order_commitment: "public_demo_work_order_route",
      attestation_commitment: "public_demo_attestation_route",
      result_commitment: "public_demo_result_route",
      expires_at: "2026-08-06T12:10:00.000Z",
    },
    proof_chain: [
      { step: "policy_checked", commitment: "public_demo_policy_route" },
      { step: "no_submit_result_committed", commitment: "public_demo_result_route" },
    ],
    worker: {
      endpoint_configured: true,
      endpoint_url_commitment: "public_demo_worker_endpoint_route",
      reachable: true,
      ready: true,
      attested_ready: true,
      provider: "phala",
      tee_kind: "phala",
      recipient_id: "phala:route",
      recipient_commitment: "public_demo_worker_recipient_route",
      image_digest_commitment: "public_demo_worker_image_route",
      report_data_commitment: "public_demo_worker_report_route",
      quote_hash_commitment: "public_demo_worker_quote_route",
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
