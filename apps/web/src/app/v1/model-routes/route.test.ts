import { afterEach, describe, expect, it } from "vitest";

import { GET } from "./route";
import { GET as GETModels } from "./models/route";

const ENV_KEYS = [
  "VENICE_API_KEY",
  "GHOLA_VENICE_API_KEY",
  "OPENAI_API_KEY",
  "GHOLA_LOCAL_OPENAI_BASE_URL",
  "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
] as const;

describe("v1 model-routes backend API", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("returns the backend route catalog", async () => {
    process.env.VENICE_API_KEY = "secret";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example.com";

    const res = await GET();
    const body = await res.json();
    const venice = body.data.find((route: { id: string }) => route.id === "venice");
    const sealed = body.data.find((route: { id: string }) => route.id === "sealed_ghola");

    expect(res.status).toBe(200);
    expect(venice.enabled).toBe(true);
    expect(sealed.privacy.trading_execution_allowed).toBe(true);
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("returns static model aliases for all routes", async () => {
    const res = await GETModels(new Request("https://ghola.test/v1/model-routes/models"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.route).toBe("all");
    expect(body.data.map((model: { id: string }) => model.id)).toContain("venice/<venice-model-id>");
    expect(body.data.map((model: { id: string }) => model.id)).toContain("ghola-private");
  });
});
