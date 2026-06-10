import { NextResponse } from "next/server";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;

const CREATED_AT = 1_700_000_000;
const REMOTE_AGENT_COMPUTE_DISCLOSURE =
  "Remote prompt-confidential inference requires ghola-local or sealed inference; plaintext remote provider execution is disabled for ghola-private and agent:* routes. Shielded x402 protects settlement metadata.";

const MODELS = [
  {
    id: "ghola-private",
    owned_by: "ghola",
    privacy_modes: ["private"],
    payment_rails: ["private_shielded_auto", "aleo_usdcx_shielded", "railgun_evm_shielded", "solana_shielded_pool"],
    prompt_confidentiality: "sealed_or_local_required",
    payment_privacy_scope: "shielded_payment_available",
    privacy_boundary: REMOTE_AGENT_COMPUTE_DISCLOSURE,
    description: "Default prompt-confidential route; use browser local inference or sealed remote inference.",
  },
  {
    id: "ghola-local",
    owned_by: "ghola",
    privacy_modes: ["local"],
    payment_rails: [],
    prompt_confidentiality: "local_device_only",
    payment_privacy_scope: "no_payment_required",
    privacy_boundary: "On-device local model route; prompts and responses stay on the user's hardware when local setup succeeds.",
    description: "On-device local model route for prompts that should stay on the user's hardware.",
  },
  {
    id: "ghola-open",
    owned_by: "ghola",
    privacy_modes: ["open"],
    payment_rails: [],
    prompt_confidentiality: "remote_plaintext_to_provider",
    payment_privacy_scope: "no_payment_required",
    privacy_boundary: "Explicit plaintext cloud route for users who choose open remote inference.",
    description: "Explicit plaintext cloud route for users who choose open remote inference.",
  },
  {
    id: "local/<model-id>",
    owned_by: "user",
    privacy_modes: ["local", "user_endpoint"],
    payment_rails: [],
    prompt_confidentiality: "user_controlled_endpoint",
    payment_privacy_scope: "no_payment_required",
    privacy_boundary: "Routes to a user-controlled OpenAI-compatible endpoint when backend SSRF/allowlist policy permits it. Trading credentials are rejected by /v1/model-routes.",
    description: "User-controlled OpenAI-compatible model namespace, for Ollama, vLLM, llama.cpp server, LM Studio, or similar backends.",
  },
  {
    id: "venice/<model-id>",
    owned_by: "venice",
    privacy_modes: ["private", "anonymized"],
    payment_rails: [],
    prompt_confidentiality: "venice_model_dependent",
    payment_privacy_scope: "no_payment_required",
    privacy_boundary: "Routes to Venice's OpenAI-compatible API. The selected Venice model determines whether prompts are private, anonymized, or stronger. Trading credentials are rejected by /v1/model-routes.",
    description: "Venice AI model namespace for cheaper/private/anonymized remote inference.",
  },
  {
    id: "openai/<model-id>",
    owned_by: "openai",
    privacy_modes: ["open"],
    payment_rails: [],
    prompt_confidentiality: "frontier_provider_visible",
    payment_privacy_scope: "no_payment_required",
    privacy_boundary: "Plain remote inference through the configured OpenAI-compatible frontier provider. Private and execution-sensitive prompts require explicit backend policy.",
    description: "OpenAI-compatible frontier provider namespace.",
  },
  {
    id: "agent:*",
    owned_by: "ghola",
    privacy_modes: ["private"],
    payment_rails: ["private_shielded_auto", "aleo_usdcx_shielded", "railgun_evm_shielded", "solana_shielded_pool"],
    prompt_confidentiality: "sealed_inference_required",
    payment_privacy_scope: "shielded_payment_available",
    privacy_boundary: REMOTE_AGENT_COMPUTE_DISCLOSURE,
    description: "Paid sealed agent execution namespace. Use model ids like agent:research-bot.",
  },
] as const;

export async function GET() {
  return NextResponse.json(
    {
      object: "list",
      data: MODELS.map((model) => ({
        id: model.id,
        object: "model",
        created: CREATED_AT,
        owned_by: model.owned_by,
        ghola: {
          privacy_modes: model.privacy_modes,
          payment_rails: model.payment_rails,
          prompt_confidentiality: model.prompt_confidentiality,
          payment_privacy_scope: model.payment_privacy_scope,
          privacy_boundary: model.privacy_boundary,
          receipts: true,
          description: model.description,
        },
      })),
    },
    { headers: NO_STORE_HEADERS },
  );
}
