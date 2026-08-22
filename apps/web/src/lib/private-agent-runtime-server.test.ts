import { describe, expect, it } from "vitest";
import {
  phalaProviderFromAttestationStatus,
  phalaProviderFromWorkerEvidence,
} from "./private-agent-runtime-server";
import type { PrivateAgentRuntimeStatus } from "./private-agent-runtime";

const checkedAt = "2026-08-20T19:00:00.000Z";
const executionUrl = "https://worker.example.com";
const recipientId = "phala:cvm:proof";
const recipientX25519 = "11".repeat(32);
const measurementHex = `sha256:${"22".repeat(32)}`;

function status(): PrivateAgentRuntimeStatus {
  return {
    version: 1,
    checked_at: checkedAt,
    sealed_execution_required: true,
    entitlement_required: "paid_private_agent_plan",
    bounded_beta_enabled: true,
    operator_spend_lock: false,
    preferred_provider: "phala",
    selected_provider: "phala",
    remote_execution_ready: false,
    shielded_rail_ready: false,
    providers: [
      {
        id: "phala",
        label: "Phala TEE",
        configured: true,
        available: true,
        attested: true,
        supports_sealed_secrets: true,
        supports_background_agents: true,
        supports_trading_execution: true,
        reason: null,
        execution_url: executionUrl,
        sealed_recipient: {
          recipient_id: recipientId,
          x25519_pub_hex: recipientX25519,
          measurement_hex: measurementHex,
          attestation_hash: "attestation-proof",
        },
        evidence: {
          report_data_bound: true,
          funding_signer_bound: true,
          phala_attestation_present: true,
        },
      },
    ],
    blocking_reasons: ["no_ready_shielded_settlement_rail"],
    disclosure: "test",
  };
}

describe("phalaProviderFromAttestationStatus", () => {
  it("accepts fresh attestation evidence only when every pinned field matches", () => {
    expect(phalaProviderFromAttestationStatus({
      status: status(),
      executionUrl,
      recipientId,
      recipientX25519,
      measurementHex,
      nowMs: Date.parse(checkedAt) + 60_000,
    })?.id).toBe("phala");
  });

  it("rejects stale attestation evidence", () => {
    expect(phalaProviderFromAttestationStatus({
      status: status(),
      executionUrl,
      recipientId,
      recipientX25519,
      measurementHex,
      nowMs: Date.parse(checkedAt) + 6 * 60_000,
    })).toBeNull();
  });

  it("rejects a mismatched worker recipient", () => {
    expect(phalaProviderFromAttestationStatus({
      status: status(),
      executionUrl,
      recipientId: "phala:cvm:different",
      recipientX25519,
      measurementHex,
      nowMs: Date.parse(checkedAt),
    })).toBeNull();
  });
});

describe("phalaProviderFromWorkerEvidence", () => {
  const fundingSigner = "pinned-worker-signer";
  const imageDigest = `sha256:${"33".repeat(32)}`;
  const reportData = "0xddeec5dd13435c621080c1ed6f0c339e64e9e557bdf1fe16aa8caa2ec10580cb";
  const attestationHash = "recipient-attestation-hash";
  const healthAttestationHash = "health-attestation-hash";
  const health = {
    status: "green",
    ok: true,
    ready: true,
    attested: true,
    attested_ready: true,
    sealed_execution_required: true,
    plaintext_rejected: true,
    provider: "phala",
    tee_kind: "phala",
    checked_at: checkedAt,
    runtime_attestation_commitment: "runtime-attestation",
    runtime_measurement_commitment: "runtime-measurement",
    runtime_policy_commitment: "runtime-policy",
    image_digest: imageDigest,
    report_data_hex: reportData,
    attestation_hash: healthAttestationHash,
    quote_hash: healthAttestationHash,
    missing: [],
  };
  const recipient = {
    recipient_id: recipientId,
    x25519_pub_hex: recipientX25519,
    funding_signer_public_key_b64: fundingSigner,
    tee_kind: "phala",
    image_digest: imageDigest,
    report_data_hex: reportData,
    attestation_hash: attestationHash,
    quote_hash: attestationHash,
    attested_ready: true,
    expires_at_unix: null,
  };

  it("accepts independently refreshed recipient and health attestations", () => {
    expect(phalaProviderFromWorkerEvidence({
      executionUrl,
      health,
      recipient,
      fundingSignerPins: [fundingSigner],
      imageDigestPin: imageDigest,
      nowMs: Date.parse(checkedAt) + 60_000,
    })?.evidence?.direct_worker_evidence).toBe(true);
  });

  it("rejects unpinned signer or image evidence", () => {
    expect(phalaProviderFromWorkerEvidence({
      executionUrl,
      health,
      recipient,
      fundingSignerPins: ["different-signer"],
      imageDigestPin: imageDigest,
      nowMs: Date.parse(checkedAt),
    })).toBeNull();
    expect(phalaProviderFromWorkerEvidence({
      executionUrl,
      health,
      recipient,
      fundingSignerPins: [fundingSigner],
      imageDigestPin: `sha256:${"44".repeat(32)}`,
      nowMs: Date.parse(checkedAt),
    })).toBeNull();
  });

  it("rejects stale or mismatched attestation evidence", () => {
    expect(phalaProviderFromWorkerEvidence({
      executionUrl,
      health,
      recipient: { ...recipient, report_data_hex: "0xdeadbeef" },
      fundingSignerPins: [fundingSigner],
      imageDigestPin: imageDigest,
      nowMs: Date.parse(checkedAt),
    })).toBeNull();
    expect(phalaProviderFromWorkerEvidence({
      executionUrl,
      health: { ...health, quote_hash: "different-health-quote" },
      recipient,
      fundingSignerPins: [fundingSigner],
      imageDigestPin: imageDigest,
      nowMs: Date.parse(checkedAt),
    })).toBeNull();
    expect(phalaProviderFromWorkerEvidence({
      executionUrl,
      health,
      recipient,
      fundingSignerPins: [fundingSigner],
      imageDigestPin: imageDigest,
      nowMs: Date.parse(checkedAt) + 6 * 60_000,
    })).toBeNull();
  });
});
