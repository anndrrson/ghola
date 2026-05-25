import { describe, expect, it } from "vitest";
import {
  buildAcceptedPrivateAgentSession,
  validatePrivateAgentSessionRequest,
} from "./private-agent-session";

const encryptedRequest = {
  version: 1,
  strategy_id: "strategy_123",
  policy_hash: "hash_policy",
  owner_did: "did:key:z123",
  mode: "capped_session_key",
  encrypted_strategy_bundle: {
    alg: "sealed-provider-v1",
    ciphertext: "base64-ciphertext",
    recipient: "phala:cvm:abc",
    aad: "ghola/private-agent-session-v1",
  },
} as const;

describe("private agent session", () => {
  it("accepts encrypted strategy bundles", () => {
    const result = validatePrivateAgentSessionRequest(encryptedRequest);

    expect(result.ok).toBe(true);
    expect(result.request?.strategy_id).toBe("strategy_123");
  });

  it("rejects plaintext strategy fields", () => {
    const result = validatePrivateAgentSessionRequest({
      ...encryptedRequest,
      source: "DCA $25 into ETH every Friday",
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("plaintext");
  });

  it("requires a ciphertext recipient and aad", () => {
    const result = validatePrivateAgentSessionRequest({
      ...encryptedRequest,
      encrypted_strategy_bundle: {
        alg: "sealed-provider-v1",
        ciphertext: "",
        recipient: "",
        aad: "",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("encrypted_strategy_bundle.ciphertext is required");
    expect(result.errors).toContain("encrypted_strategy_bundle.recipient is required");
    expect(result.errors).toContain("encrypted_strategy_bundle.aad is required");
  });

  it("builds sealed execution session receipts without strategy plaintext", () => {
    const validation = validatePrivateAgentSessionRequest(encryptedRequest);
    expect(validation.request).toBeDefined();

    const accepted = buildAcceptedPrivateAgentSession({
      provider: "mock_attested",
      request: validation.request!,
      acceptedAt: "2026-05-24T00:00:00.000Z",
      sessionId: "pas_test",
    });

    expect(accepted).toEqual({
      version: 1,
      session_id: "pas_test",
      provider: "mock_attested",
      strategy_id: "strategy_123",
      policy_hash: "hash_policy",
      accepted_at: "2026-05-24T00:00:00.000Z",
      sealed_execution_required: true,
    });
  });
});
