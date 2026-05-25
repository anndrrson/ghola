import { describe, expect, it } from "vitest";

import { POST } from "./route";

function jsonRequest(body: unknown) {
  return new Request("https://ghola.test/api/aleo-shielded/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

describe("Aleo shielded verifier route", () => {
  it("rejects oversized proof payloads before verifier work", async () => {
    const res = await POST(
      jsonRequest({
        provider: "aleo",
        network: "aleo:mainnet",
        asset: "USDCx",
        destination: "aleo1destination",
        required_amount: 1,
        proof: {
          tx_signature: "at1transaction",
          proof_b64: "a".repeat(16 * 1024 + 1),
        },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("proof_b64 is too long");
  });
});
