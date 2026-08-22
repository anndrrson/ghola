import assert from "node:assert/strict";
import test from "node:test";
import { publicDecisionProviderStatus, resolveDecisionModel } from "../src/execution/decision-provider.js";

test("resolves legacy AI SDK Gateway model strings", () => {
  const resolved = resolveDecisionModel({
    env: { PRIVATE_AGENT_AI_MODEL: "openai/example-model" },
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.model, "openai/example-model");
  assert.equal(resolved.metadata.provider_kind, "gateway");
});

test("resolves Ollama through its loopback OpenAI-compatible endpoint", () => {
  const resolved = resolveDecisionModel({
    env: {
      PRIVATE_AGENT_AI_PROVIDER_KIND: "ollama",
      PRIVATE_AGENT_AI_MODEL: "local-model",
      PRIVATE_AGENT_AI_API_KEY: "must-never-be-public",
    },
  });
  assert.equal(resolved.ok, true);
  assert.equal(typeof resolved.model, "object");
  assert.equal(resolved.metadata.endpoint_origin, "http://127.0.0.1:11434");
  assert.equal(resolved.metadata.local, true);
  assert.equal(JSON.stringify(resolved.metadata).includes("must-never-be-public"), false);
});

test("requires an explicit origin allowlist for remote compatible providers", () => {
  const blocked = resolveDecisionModel({
    env: {
      PRIVATE_AGENT_AI_PROVIDER_KIND: "openai_compatible",
      PRIVATE_AGENT_AI_MODEL: "approved-model",
      PRIVATE_AGENT_AI_BASE_URL: "https://models.example/v1",
    },
  });
  assert.deepEqual(blocked, { ok: false, error: "ai_provider_origin_not_approved" });

  const allowed = resolveDecisionModel({
    env: {
      PRIVATE_AGENT_AI_PROVIDER_KIND: "openai_compatible",
      PRIVATE_AGENT_AI_MODEL: "approved-model",
      PRIVATE_AGENT_AI_BASE_URL: "https://models.example/v1",
      PRIVATE_AGENT_AI_ALLOWED_ORIGINS: "https://models.example",
    },
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.metadata.endpoint_origin, "https://models.example");
});

test("rejects credentials in URLs and public cleartext endpoints", () => {
  const credentialed = resolveDecisionModel({
    env: {
      PRIVATE_AGENT_AI_PROVIDER_KIND: "openai_compatible",
      PRIVATE_AGENT_AI_MODEL: "model",
      PRIVATE_AGENT_AI_BASE_URL: "https://secret@models.example/v1",
      PRIVATE_AGENT_AI_ALLOWED_ORIGINS: "https://models.example",
    },
  });
  assert.equal(credentialed.error, "ai_provider_base_url_unsafe");

  const cleartext = resolveDecisionModel({
    env: {
      PRIVATE_AGENT_AI_PROVIDER_KIND: "vllm",
      PRIVATE_AGENT_AI_MODEL: "model",
      PRIVATE_AGENT_AI_BASE_URL: "http://203.0.113.10:8000/v1",
      PRIVATE_AGENT_AI_ALLOWED_ORIGINS: "http://203.0.113.10:8000",
    },
  });
  assert.equal(cleartext.error, "ai_provider_https_required");
});

test("provider status fails closed without exposing configuration secrets", () => {
  const status = publicDecisionProviderStatus({
    env: {
      PRIVATE_AGENT_AI_PROVIDER_KIND: "ollama",
      PRIVATE_AGENT_AI_API_KEY: "secret",
    },
  });
  assert.deepEqual(status, { version: 1, configured: false, error: "ai_model_unconfigured" });
  assert.equal(JSON.stringify(status).includes("secret"), false);
});
