import { describe, expect, it } from "vitest";
import { hyperliquidReleaseIdentity } from "@/lib/hyperliquid-release-identity";

describe("Hyperliquid release identity", () => {
  it("binds one web commit and deployment to one pinned worker artifact", () => {
    const identity = hyperliquidReleaseIdentity({
      VERCEL_GIT_COMMIT_SHA: "abc123",
      VERCEL_URL: "preview.example",
      GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: "sha256:worker123",
      GHOLA_PRIVATE_RUNTIME_EXPECTED_MEASUREMENT: "measurement123",
    });

    expect(identity).toMatchObject({
      ready: true,
      web_commit_sha: "abc123",
      web_deployment_url: "https://preview.example",
      worker_image_digest: "sha256:worker123",
      worker_expected_measurement: "measurement123",
      proof_protocol: "ghola-hyperliquid-proof-v2",
      no_submit_order_contract: "tiny_fill_ioc_v1",
      reason_codes: [],
    });
    expect(identity.release_identity_commitment).toMatch(/^hyperliquid_release_identity_/);
  });

  it("fails closed when the worker artifact is not pinned", () => {
    expect(hyperliquidReleaseIdentity({
      VERCEL_GIT_COMMIT_SHA: "abc123",
      VERCEL_URL: "preview.example",
    })).toMatchObject({
      ready: false,
      release_identity_commitment: null,
      reason_codes: ["hyperliquid_release_worker_artifact_missing"],
    });
  });
});
