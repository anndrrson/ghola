import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("v1 models privacy metadata", () => {
  it("separates prompt confidentiality from shielded payment privacy", async () => {
    const res = await GET();
    const body = await res.json();
    const agent = body.data.find((model: { id: string }) => model.id === "agent:*");
    const privateModel = body.data.find((model: { id: string }) => model.id === "ghola-private");
    const local = body.data.find((model: { id: string }) => model.id === "ghola-local");
    const localEndpoint = body.data.find((model: { id: string }) => model.id === "local/<model-id>");
    const venice = body.data.find((model: { id: string }) => model.id === "venice/<model-id>");

    expect(privateModel.ghola.prompt_confidentiality).toBe("sealed_or_local_required");
    expect(agent.ghola.prompt_confidentiality).toBe("sealed_inference_required");
    expect(agent.ghola.payment_privacy_scope).toBe("shielded_payment_available");
    expect(agent.ghola.privacy_boundary).toContain("plaintext remote provider execution is disabled");
    expect(local.ghola.prompt_confidentiality).toBe("local_device_only");
    expect(local.ghola.payment_privacy_scope).toBe("no_payment_required");
    expect(localEndpoint.ghola.prompt_confidentiality).toBe("user_controlled_endpoint");
    expect(localEndpoint.ghola.privacy_boundary).toContain("Trading credentials are rejected");
    expect(venice.ghola.prompt_confidentiality).toBe("venice_model_dependent");
    expect(venice.ghola.privacy_boundary).toContain("selected Venice model determines");
  });
});
