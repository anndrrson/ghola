import { describe, expect, it } from "vitest";

import { gholaCommitment } from "./private-account";
import {
  freshSealedRuntimeHealth,
  sealedRuntimeHealth,
} from "./private-account-runtime";

describe("private-account sealed runtime health", () => {
  it("keeps local_test usable outside production", () => {
    const health = sealedRuntimeHealth(new Date("2026-01-01T00:00:00.000Z"), {
      NODE_ENV: "test",
      GHOLA_CONNECTOR_MODE: "local_test",
    });

    expect(health.status).toBe("green");
    expect(health.runtime_attestation_commitment).toMatch(/^runtime_attestation_/);
  });

  it("accepts fresh http runtime health with matching commitments", async () => {
    const observedAt = new Date("2026-01-01T00:00:00.000Z");
    const health = await freshSealedRuntimeHealth(
      observedAt,
      {
        NODE_ENV: "production",
        GHOLA_PRIVATE_RUNTIME_URL: "https://runtime.ghola.test",
        GHOLA_PRIVATE_RUNTIME_EXPECTED_MEASUREMENT: "measurement-a",
      },
      async () =>
        new Response(JSON.stringify({
          status: "green",
          observed_at: observedAt.toISOString(),
          runtime_attestation_commitment: gholaCommitment("runtime_attestation", "attested-a"),
          runtime_measurement_commitment: gholaCommitment("runtime_measurement", "measurement-a"),
          runtime_policy_commitment: gholaCommitment("runtime_policy", "sealed_runtime_only"),
        })) as never,
    );

    expect(health.status).toBe("green");
    expect(health.reason).toBeNull();
  });

  it("rejects stale, mismatched, and unreachable http runtime health", async () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const baseEnv = {
      NODE_ENV: "production",
      GHOLA_PRIVATE_RUNTIME_URL: "https://runtime.ghola.test",
      GHOLA_PRIVATE_RUNTIME_EXPECTED_MEASUREMENT: "measurement-a",
      GHOLA_PRIVATE_RUNTIME_MAX_STALE_MS: "300000",
    };

    const stale = await freshSealedRuntimeHealth(
      now,
      baseEnv,
      async () =>
        new Response(JSON.stringify({
          status: "green",
          observed_at: "2026-01-01T00:00:00.000Z",
          runtime_attestation_commitment: gholaCommitment("runtime_attestation", "attested-a"),
          runtime_measurement_commitment: gholaCommitment("runtime_measurement", "measurement-a"),
          runtime_policy_commitment: gholaCommitment("runtime_policy", "sealed_runtime_only"),
        })) as never,
    );
    expect(stale).toMatchObject({
      status: "red",
      reason: "sealed runtime health evidence is stale",
    });

    const mismatched = await freshSealedRuntimeHealth(
      now,
      baseEnv,
      async () =>
        new Response(JSON.stringify({
          status: "green",
          observed_at: now.toISOString(),
          runtime_attestation_commitment: gholaCommitment("runtime_attestation", "attested-a"),
          runtime_measurement_commitment: gholaCommitment("runtime_measurement", "measurement-b"),
          runtime_policy_commitment: gholaCommitment("runtime_policy", "sealed_runtime_only"),
        })) as never,
    );
    expect(mismatched).toMatchObject({
      status: "red",
      reason: "sealed runtime measurement does not match expected value",
    });

    const unreachable = await freshSealedRuntimeHealth(
      now,
      baseEnv,
      async () => {
        throw new Error("offline");
      },
    );
    expect(unreachable).toMatchObject({
      status: "red",
      reason: "sealed runtime health endpoint is unreachable",
    });
  });
});
