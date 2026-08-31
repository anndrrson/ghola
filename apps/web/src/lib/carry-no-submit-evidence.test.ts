import { describe, expect, it } from "vitest";
import { buildCarryNoSubmitEvidence } from "./carry-no-submit-evidence";

const ENV = {
  VERCEL_URL: "web-proof-anndrrsons-projects.vercel.app",
  VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
};

describe("Carry no-submit evidence", () => {
  it("binds a ready signed matrix to exact Preview and worker identities without credentials", () => {
    const result = buildCarryNoSubmitEvidence({ request: request(), response: response(), env: ENV });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence).toMatchObject({
      version: 1,
      kind: "ghola_three_venue_no_submit_proof",
      network: "mainnet",
      captured_at_ms: 1_800_000_000_000,
      source: {
        preview_url: "https://web-proof-anndrrsons-projects.vercel.app",
        web_commit_sha: "a".repeat(40),
        worker_image_digest: `sha256:${"b".repeat(64)}`,
      },
    });
    const serialized = JSON.stringify(result.evidence);
    expect(serialized).not.toContain("sealed-ciphertext");
    expect(serialized).not.toContain("private-secret");
  });

  it("fails closed without release identity or with credential material in the response", () => {
    expect(buildCarryNoSubmitEvidence({ request: request(), response: response(), env: {} }))
      .toEqual({ ok: false, error: "carry_no_submit_preview_identity_missing" });
    expect(buildCarryNoSubmitEvidence({
      request: request(),
      response: { ...response(), encrypted_execution_vault: { ciphertext: "forbidden" } },
      env: ENV,
    })).toEqual({ ok: false, error: "carry_no_submit_response_contains_credential_material" });
  });

  it("refuses incomplete venue bindings and unready matrices", () => {
    const incomplete = request();
    delete incomplete.venue_access.aster;
    expect(buildCarryNoSubmitEvidence({ request: incomplete, response: response(), env: ENV }))
      .toEqual({ ok: false, error: "carry_no_submit_access_missing:aster" });
    expect(buildCarryNoSubmitEvidence({
      request: request(),
      response: { ...response(), no_submit_ready: false },
      env: ENV,
    })).toEqual({ ok: false, error: "carry_no_submit_matrix_unready" });
  });
});

function request() {
  return {
    version: 1,
    owner_commitment: "owner_commitment_0001",
    operation_class: "matrix_no_submit",
    work_order_commitment: "carry_matrix_0001",
    asset: "BTC",
    notional_usd: "11",
    horizon_days: "1",
    venue_access: Object.fromEntries(["hyperliquid", "lighter", "aster"].map((venueId) => [venueId, {
      account_commitment: `account_${venueId}`,
      vault_commitment: `vault_${venueId}`,
      policy_commitment: `policy_${venueId}`,
      encrypted_execution_vault: { ciphertext: "sealed-ciphertext" },
      api_wallet_private_key: "private-secret",
    }])) as Record<string, Record<string, unknown>>,
  };
}

function response() {
  return {
    mode: "carry_execution_no_submit_matrix",
    no_submit_ready: true,
    transaction_broadcast: false,
    failures: [],
    private_prime_readiness: { checked_at_ms: 1_800_000_000_000 },
    private_prime_authentication: { signature_b64: "signed" },
  };
}
