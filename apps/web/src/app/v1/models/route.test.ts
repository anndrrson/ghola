import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("v1 models privacy metadata", () => {
  it("separates prompt confidentiality from shielded payment privacy", async () => {
    const res = await GET();
    const body = await res.json();
    const agent = body.data.find((model: { id: string }) => model.id === "agent:*");
    const privateModel = body.data.find((model: { id: string }) => model.id === "ghola-private");
    const local = body.data.find((model: { id: string }) => model.id === "ghola-local");

    expect(privateModel.ghola.prompt_confidentiality).toBe("sealed_or_local_required");
    expect(agent.ghola.prompt_confidentiality).toBe("sealed_inference_required");
    expect(agent.ghola.payment_privacy_scope).toBe("shielded_payment_available");
    expect(agent.ghola.privacy_boundary).toContain("plaintext remote provider execution is disabled");
    expect(local.ghola.prompt_confidentiality).toBe("local_device_only");
    expect(local.ghola.payment_privacy_scope).toBe("no_payment_required");
  });
});
