import { describe, expect, it, vi } from "vitest";

import {
  listModelRoutes,
  routeModelChatCompletions,
} from "./model-router";

function chatRequest(body: unknown) {
  return new Request("https://ghola.test/v1/model-routes/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("backend model router", () => {
  it("advertises backend routes without leaking provider keys", () => {
    const catalog = listModelRoutes({
      VENICE_API_KEY: "venice-secret",
      OPENAI_API_KEY: "openai-secret",
      GHOLA_LOCAL_OPENAI_BASE_URL: "https://models.example.com/v1",
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example.com",
    });

    const venice = catalog.data.find((route) => route.id === "venice");
    const local = catalog.data.find((route) => route.id === "local_openai_compatible");
    const sealed = catalog.data.find((route) => route.id === "sealed_ghola");

    expect(venice?.enabled).toBe(true);
    expect(local?.server_callable).toBe(true);
    expect(sealed?.privacy.trading_execution_allowed).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain("venice-secret");
    expect(JSON.stringify(catalog)).not.toContain("openai-secret");
  });

  it("routes Venice through its OpenAI-compatible chat endpoint", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.venice.ai/api/v1/chat/completions");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer venice-secret");
      const payload = JSON.parse(String(init.body));
      expect(payload.model).toBe("zai-org-glm-5-1");
      expect(payload.venice_parameters).toEqual({ enable_web_search: "auto" });
      expect(payload.api_key).toBeUndefined();
      return new Response(JSON.stringify({
        id: "chatcmpl_test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await routeModelChatCompletions(
      chatRequest({
        route: "venice",
        model: "venice/zai-org-glm-5-1",
        messages: [{ role: "user", content: "hello" }],
        venice_parameters: { enable_web_search: "auto" },
      }),
      { VENICE_API_KEY: "venice-secret" },
      fetchMock as unknown as typeof fetch,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-ghola-model-route")).toBe("venice");
    expect(await res.json()).toMatchObject({ id: "chatcmpl_test" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("supports a configured local OpenAI-compatible endpoint for self-hosted deployments", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
      const payload = JSON.parse(String(init.body));
      expect(payload.model).toBe("llama3.1:405b");
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await routeModelChatCompletions(
      chatRequest({
        route: "local_openai_compatible",
        model: "local/llama3.1:405b",
        messages: [{ role: "user", content: "reason locally" }],
      }),
      {
        NODE_ENV: "test",
        GHOLA_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects request-supplied private-network endpoints", async () => {
    const res = await routeModelChatCompletions(
      chatRequest({
        route: "local_openai_compatible",
        model: "local/model",
        base_url: "https://192.168.1.10/v1",
        messages: [{ role: "user", content: "hello" }],
      }),
      {
        GHOLA_MODEL_ROUTER_USER_ENDPOINTS_ENABLED: "true",
        GHOLA_MODEL_ROUTER_ALLOWED_ENDPOINT_HOSTS: "192.168.1.10",
      },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "private_network_endpoint_not_allowed",
    });
  });

  it("rejects execution credentials and trade submission payloads on generic model routes", async () => {
    const res = await routeModelChatCompletions(
      chatRequest({
        route: "venice",
        model: "venice/zai-org-glm-5-1",
        messages: [{ role: "user", content: "analyze" }],
        venue_credentials: { api_secret: "do-not-send" },
      }),
      { VENICE_API_KEY: "venice-secret" },
    );

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      error: "model_route_rejects_execution_or_credential_payloads",
      path: "$.venue_credentials",
    });
  });

  it("keeps browser-local and sealed execution routes out of the generic cloud proxy", async () => {
    const localRes = await routeModelChatCompletions(
      chatRequest({
        model: "local-webgpu/default",
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    expect(localRes.status).toBe(409);
    await expect(localRes.json()).resolves.toMatchObject({
      error: "client_side_local_route_required",
    });

    const sealedRes = await routeModelChatCompletions(
      chatRequest({
        model: "ghola-private",
        messages: [{ role: "user", content: "execution-sensitive" }],
      }),
    );
    expect(sealedRes.status).toBe(409);
    await expect(sealedRes.json()).resolves.toMatchObject({
      error: "sealed_route_requires_private_execution_api",
    });
  });
});
