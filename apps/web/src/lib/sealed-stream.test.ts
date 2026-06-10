import { describe, expect, it } from "vitest";

import type { ReceiptV1 } from "./receipt";
import { validatePrivateReceiptProof } from "./sealed-stream";

function baseReceipt(): ReceiptV1 {
  return {
    version: 1,
    job_id: "job-1",
    mode: "private",
    provider_id: "provider-1",
    model_id: "model-1",
    input_token_hash: "a",
    output_token_hash: "b",
    issued_at: Date.now(),
    enclave_key_id: "key-1",
    attestation_hash: "att-1",
    measurement: "meas-1",
    signer_did: "did:key:ztest",
    signature: "sig",
    provider_signature: "provider-sig",
  };
}

describe("sealed-stream private proof invariants", () => {
  it("fails when receipt mode is not private", async () => {
    const receipt = baseReceipt();
    receipt.mode = "open";

    const result = await validatePrivateReceiptProof(receipt);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/unexpected receipt mode/i);
    }
  });

  it("fails when required provider proof fields are missing", async () => {
    const receipt = baseReceipt();
    receipt.provider_signature = null;
    receipt.attestation_hash = null;
    receipt.measurement = null;
    receipt.enclave_key_id = null;

    const result = await validatePrivateReceiptProof(receipt);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/missing provider_signature/i);
    }
  });
});
