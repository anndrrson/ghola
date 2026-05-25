use std::convert::Infallible;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::sse::{Event, Sse};
use axum::Json;
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use futures::stream::Stream;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::auth::Claims;
use crate::error::CloudError;
use crate::privacy::{record_privacy_audit_event, NetworkScope, PrivacyApproval};
use crate::services::{
    agent_service, compute_service,
    llm_router::{self, ChatMsg},
    x402_service,
};
use crate::state::AppState;

const PAYMENT_PROOF_HEADER_ALIASES: &[&str] = &["payment-signature", "x-payment", "x402-payment"];

fn payment_proof_header(headers: &HeaderMap) -> Option<&str> {
    PAYMENT_PROOF_HEADER_ALIASES
        .iter()
        .find_map(|name| headers.get(*name).and_then(|v| v.to_str().ok()))
}

const PAYMENT_RAIL_HEADER_ALIASES: &[&str] =
    &["x-ghola-payment-rail", "x-payment-rail", "payment-rail"];

fn payment_rail_header(headers: &HeaderMap) -> Option<&str> {
    PAYMENT_RAIL_HEADER_ALIASES
        .iter()
        .find_map(|name| headers.get(*name).and_then(|v| v.to_str().ok()))
}

const CREATED_AT: i64 = 1_700_000_000;
const GHOLA_PRIVATE_MODEL: &str = "ghola-private";
const GHOLA_LOCAL_MODEL: &str = "ghola-local";
const GHOLA_OPEN_MODEL: &str = "ghola-open";
const AGENT_MODEL_NAMESPACE: &str = "agent:";
const PRIVATE_PAYMENT_RAIL: &str = "private_shielded_auto";
const SEALED_OR_LOCAL_DISCLOSURE: &str = "Prompt-confidential routes require ghola-local or sealed inference. Plaintext remote provider execution is disabled for ghola-private and agent:*.";

fn is_agent_model(model: Option<&str>) -> bool {
    model
        .map(|m| m.starts_with(AGENT_MODEL_NAMESPACE))
        .unwrap_or(false)
}

fn is_local_model(model: Option<&str>) -> bool {
    model == Some(GHOLA_LOCAL_MODEL)
}

fn is_supported_public_model(model: Option<&str>) -> bool {
    match model {
        None | Some(GHOLA_PRIVATE_MODEL) | Some(GHOLA_LOCAL_MODEL) | Some(GHOLA_OPEN_MODEL) => true,
        Some(model) => model.starts_with(AGENT_MODEL_NAMESPACE),
    }
}

fn response_model_name(requested: Option<&str>, configured: &str) -> String {
    match requested {
        None => GHOLA_PRIVATE_MODEL.to_string(),
        Some(GHOLA_PRIVATE_MODEL) => GHOLA_PRIVATE_MODEL.to_string(),
        Some(GHOLA_OPEN_MODEL) => configured.to_string(),
        Some(model) if model.starts_with(AGENT_MODEL_NAMESPACE) => model.to_string(),
        _ => configured.to_string(),
    }
}

fn chat_request_hash(req: &ChatCompletionRequest, max_tokens: u32) -> Result<String, CloudError> {
    let sealed_request_sha256 = req.sealed_request_b64.as_deref().map(|raw| {
        let hash = Sha256::digest(raw.as_bytes());
        hex::encode(hash)
    });
    let binding = serde_json::json!({
        "version": "ghola-x402-request-v1",
        "model": req.model.as_deref().unwrap_or(GHOLA_PRIVATE_MODEL),
        "messages": &req.messages,
        "sealed_request_sha256": sealed_request_sha256,
        "enclave_key_id": &req.enclave_key_id,
        "max_tokens": max_tokens,
        "temperature": req.temperature,
    });
    let bytes = serde_json::to_vec(&binding)
        .map_err(|e| CloudError::Internal(format!("request hash serialization failed: {e}")))?;
    Ok(hex::encode(Sha256::digest(&bytes)))
}

// ---------------------------------------------------------------------------
// Request/Response types (OpenAI-compatible)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Serialize)]
pub struct ChatCompletionRequest {
    #[serde(default)]
    pub messages: Vec<MessageInput>,
    pub model: Option<String>,
    pub stream: Option<bool>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f64>,
    #[serde(default)]
    pub enclave_key_id: Option<String>,
    #[serde(default)]
    pub sealed_request_b64: Option<String>,
    #[serde(default)]
    pub sealed_job_id: Option<String>,
    #[serde(flatten)]
    pub approval: PrivacyApproval,
}

#[derive(Deserialize, Serialize)]
pub struct MessageInput {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct ChatCompletion {
    pub id: String,
    pub object: &'static str,
    pub created: i64,
    pub model: String,
    pub choices: Vec<Choice>,
    pub usage: Usage,
}

#[derive(Serialize)]
pub struct SealedChatCompletion {
    pub id: String,
    pub object: &'static str,
    pub created: i64,
    pub model: String,
    pub ciphertext_b64: String,
    pub is_final: bool,
    pub ghola: SealedChatMetadata,
}

#[derive(Serialize)]
pub struct SealedChatMetadata {
    pub prompt_confidentiality: &'static str,
    pub payment_privacy_scope: &'static str,
    pub enclave_key_id: String,
    pub relay_sealed: bool,
}

#[derive(Serialize)]
pub struct Choice {
    pub index: u32,
    pub message: ChoiceMessage,
    pub finish_reason: &'static str,
}

#[derive(Serialize)]
pub struct ChoiceMessage {
    pub role: &'static str,
    pub content: String,
}

#[derive(Serialize)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

#[derive(Serialize)]
pub struct ModelList {
    pub object: &'static str,
    pub data: Vec<ModelInfo>,
}

#[derive(Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub object: &'static str,
    pub created: i64,
    pub owned_by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ghola: Option<ModelMetadata>,
}

#[derive(Clone, Serialize)]
pub struct ModelMetadata {
    pub privacy_modes: Vec<&'static str>,
    pub payment_rails: Vec<&'static str>,
    pub prompt_confidentiality: &'static str,
    pub payment_privacy_scope: &'static str,
    pub privacy_boundary: &'static str,
    pub receipts: bool,
    pub description: &'static str,
}

fn canonical_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: GHOLA_PRIVATE_MODEL.to_string(),
            object: "model",
            created: CREATED_AT,
            owned_by: "ghola".to_string(),
            ghola: Some(ModelMetadata {
                privacy_modes: vec!["private"],
                payment_rails: vec![
                    "private_shielded_auto",
                    "aleo_usdcx_shielded",
                    "railgun_evm_shielded",
                    "solana_shielded_pool",
                ],
                prompt_confidentiality: "sealed_or_local_required",
                payment_privacy_scope: "shielded_payment_available",
                privacy_boundary: SEALED_OR_LOCAL_DISCLOSURE,
                receipts: true,
                description: "Default prompt-confidential route; use browser local inference or sealed remote inference.",
            }),
        },
        ModelInfo {
            id: GHOLA_LOCAL_MODEL.to_string(),
            object: "model",
            created: CREATED_AT,
            owned_by: "ghola".to_string(),
            ghola: Some(ModelMetadata {
                privacy_modes: vec!["local"],
                payment_rails: vec![],
                prompt_confidentiality: "local_device_only",
                payment_privacy_scope: "no_payment_required",
                privacy_boundary: "On-device local model route; prompts and responses stay on the user's hardware when local setup succeeds.",
                receipts: true,
                description: "On-device local model route for prompts that should stay on the user's hardware.",
            }),
        },
        ModelInfo {
            id: GHOLA_OPEN_MODEL.to_string(),
            object: "model",
            created: CREATED_AT,
            owned_by: "ghola".to_string(),
            ghola: Some(ModelMetadata {
                privacy_modes: vec!["open"],
                payment_rails: vec![],
                prompt_confidentiality: "remote_plaintext_to_provider",
                payment_privacy_scope: "no_payment_required",
                privacy_boundary: "Explicit open route sends plaintext prompt/model requests to the configured remote provider.",
                receipts: true,
                description: "Explicit plaintext cloud route for users who choose open remote inference.",
            }),
        },
        ModelInfo {
            id: "agent:*".to_string(),
            object: "model",
            created: CREATED_AT,
            owned_by: "ghola".to_string(),
            ghola: Some(ModelMetadata {
                privacy_modes: vec!["private"],
                payment_rails: vec![
                    "private_shielded_auto",
                    "aleo_usdcx_shielded",
                    "railgun_evm_shielded",
                    "solana_shielded_pool",
                ],
                prompt_confidentiality: "sealed_inference_required",
                payment_privacy_scope: "shielded_payment_available",
                privacy_boundary: SEALED_OR_LOCAL_DISCLOSURE,
                receipts: true,
                description: "Paid sealed agent execution namespace. Use model ids like agent:research-bot.",
            }),
        },
    ]
}

fn require_sealed_remote_request(req: &ChatCompletionRequest) -> Result<(), CloudError> {
    let has_enclave = req
        .enclave_key_id
        .as_deref()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let has_sealed = req
        .sealed_request_b64
        .as_deref()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if !has_enclave || !has_sealed {
        return Err(CloudError::BadRequest(
            "prompt-confidential remote inference requires enclave_key_id and sealed_request_b64; use ghola-local or the sealed inference client".into(),
        ));
    }
    if !req.messages.is_empty() {
        return Err(CloudError::BadRequest(
            "sealed remote inference must not include plaintext messages in /v1/chat/completions"
                .into(),
        ));
    }
    if req.stream == Some(true) {
        return Err(CloudError::BadRequest(
            "sealed remote inference returns an encrypted non-streaming response; streaming sealed chunks are not enabled on this route".into(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// POST /v1/chat/completions
// ---------------------------------------------------------------------------

/// Handles three paths:
/// 1. model starts with "agent:" → x402 payment flow
/// 2. Authorization: Bearer <jwt> → existing BYOM/cascade flow
/// 3. Authorization: Bearer <api-key> → existing API key flow
pub async fn chat_completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChatCompletionRequest>,
) -> Result<axum::response::Response, CloudError> {
    if !is_supported_public_model(req.model.as_deref()) {
        return Err(CloudError::BadRequest(
            "unsupported model id; use ghola-private, ghola-local, ghola-open, or agent:<slug>"
                .into(),
        ));
    }

    if is_local_model(req.model.as_deref()) {
        return Err(CloudError::BadRequest(
            "ghola-local runs on the user's device and is not available through the cloud API"
                .into(),
        ));
    }

    if matches!(req.model.as_deref(), None | Some(GHOLA_PRIVATE_MODEL)) {
        return Err(CloudError::BadRequest(
            "ghola-private no longer runs plaintext remote inference through /v1/chat/completions; use ghola-local in the browser or sealed inference".into(),
        ));
    }

    // Agent model ids always mean paid agent execution. Do not silently
    // treat them as a normal BYOM model override for authenticated users.
    if is_agent_model(req.model.as_deref()) {
        return handle_x402_agent_request(&state, &headers, req).await;
    }

    // Otherwise, require auth (JWT or API key) — existing flow
    let claims = extract_auth(&headers, &state).await?;
    let approval = req
        .approval
        .require_and_store_for(NetworkScope::RemoteAgentCompute)?;
    record_privacy_audit_event(
        &state.db,
        claims.sub,
        NetworkScope::RemoteAgentCompute,
        &approval,
        "openai_compatible_chat",
    )
    .await;

    if req.stream == Some(true) {
        let sse = chat_completions_stream(state, claims, req).await?;
        Ok(sse.into_response())
    } else {
        let json = chat_completions_non_stream(state, claims, req).await?;
        Ok(json.into_response())
    }
}

/// Extract auth claims from the Authorization header (JWT or API key).
async fn extract_auth(headers: &HeaderMap, state: &AppState) -> Result<Claims, CloudError> {
    let auth_header = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or(CloudError::Unauthorized)?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or(CloudError::Auth("expected Bearer token".to_string()))?;

    if token.starts_with("sk-ghola-") {
        // API key path — hash and look up
        let key_hash = crate::auth::hash_api_key(token);
        let row = sqlx::query_as::<_, (Uuid, Uuid)>(
            "SELECT id, user_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
        )
        .bind(&key_hash)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| CloudError::Internal(format!("api key lookup failed: {e}")))?
        .ok_or(CloudError::Auth("invalid or revoked API key".to_string()))?;

        let (_api_key_id, user_id) = row;
        let user_row = sqlx::query_as::<_, (Option<String>, String)>(
            "SELECT email, tier FROM users WHERE id = $1",
        )
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| CloudError::Internal(format!("user lookup failed: {e}")))?
        .ok_or(CloudError::Auth("user not found".to_string()))?;

        let now = Utc::now();
        Ok(Claims {
            sub: user_id,
            email: user_row.0,
            name: None,
            tier: user_row.1,
            exp: (now + chrono::Duration::days(1)).timestamp(),
            iat: now.timestamp(),
        })
    } else {
        crate::auth::verify_jwt(token, &state.config.jwt_secret)
    }
}

use axum::response::IntoResponse;

// ---------------------------------------------------------------------------
// x402 Agent Request Handler
// ---------------------------------------------------------------------------

async fn handle_x402_agent_request(
    state: &AppState,
    headers: &HeaderMap,
    req: ChatCompletionRequest,
) -> Result<axum::response::Response, CloudError> {
    // Parse agent slug from model: "agent:research-bot" → "research-bot"
    let model_str = req.model.as_deref().unwrap_or("");
    let slug = model_str
        .strip_prefix("agent:")
        .ok_or_else(|| CloudError::BadRequest("invalid agent model format".into()))?;
    require_sealed_remote_request(&req)?;
    let enclave_key_id = req
        .enclave_key_id
        .clone()
        .expect("sealed request validation requires enclave_key_id");
    let sealed_request_b64 = req
        .sealed_request_b64
        .clone()
        .expect("sealed request validation requires sealed_request_b64");

    // Look up agent — 404 before 402
    let agent_info = agent_service::get_public_agent(&state.db, slug).await?;

    // Get the matched agent details (need provider relay_pubkey, system_prompt, etc.)
    let matched = agent_service::match_agents(
        &state.db,
        &agent_service::AgentMatchCriteria {
            require_tags: vec![],
            require_tools: vec![],
            prefer_model: None,
            min_reputation: 0.0,
            limit: 100,
        },
    )
    .await?;

    let matched_agent = matched
        .iter()
        .find(|a| a.agent_id == agent_info.id)
        .ok_or_else(|| CloudError::ServiceUnavailable("agent's provider is offline".into()))?;

    if matched_agent.max_tokens <= 0 {
        return Err(CloudError::ServiceUnavailable(
            "agent has invalid token capacity".into(),
        ));
    }
    let provider_max_tokens = matched_agent.max_tokens as u32;
    let max_tokens = req.max_tokens.unwrap_or(provider_max_tokens);
    if max_tokens == 0 || max_tokens > provider_max_tokens {
        return Err(CloudError::BadRequest(format!(
            "max_tokens must be between 1 and {provider_max_tokens}"
        )));
    }
    let enclave_matches_provider = compute_service::attested_enclave_matches_provider(
        state,
        &matched_agent.model_id,
        &enclave_key_id,
        &matched_agent.relay_pubkey,
    )
    .await?;
    if !enclave_matches_provider {
        return Err(CloudError::ServiceUnavailable(
            "sealed enclave is not attested for this agent provider/model".into(),
        ));
    }
    let required_amount = x402_service::estimate_agent_price(
        matched_agent.price_per_1k_input,
        matched_agent.price_per_1k_output,
        max_tokens,
    );
    let request_hash = chat_request_hash(&req, max_tokens)?;
    let requested_rail_header = payment_rail_header(headers);
    let requested_rail_preference = requested_rail_header.or(Some(PRIVATE_PAYMENT_RAIL));
    let requested_rail = x402_service::parse_requested_payment_rail(requested_rail_preference)?;
    if requested_rail == x402_service::PaymentRailKind::SolanaPublicStablecoin {
        return Ok(x402_service::build_shielded_fallback_rejected_response());
    }

    // Accept canonical x402 and existing Ghola header aliases. Verification
    // normalizes the decoded proof, so replay protection is rail/proof based,
    // not header-name based.
    let payment_header = payment_proof_header(headers);

    let payment_header = match payment_header {
        Some(h) => h,
        None => {
            if requested_rail == x402_service::PaymentRailKind::PrivateShieldedAuto {
                if !x402_service::any_shielded_rail_ready() {
                    return Ok(x402_service::build_no_payment_options_response(
                        requested_rail,
                        Some(x402_service::any_shielded_unavailable_reason()),
                    ));
                }
            } else if requested_rail == x402_service::PaymentRailKind::ShieldedStablecoin {
                let shielded = x402_service::shielded_stablecoin_runtime_status();
                if !shielded.ready {
                    return Ok(x402_service::build_no_payment_options_response(
                        requested_rail,
                        shielded.unavailable_reason,
                    ));
                }
            }
            // No payment — return 402 with requirements
            let mut requirements = x402_service::build_payment_requirements(
                state,
                agent_info.id,
                &agent_info.slug,
                &agent_info.model_id,
                matched_agent.price_per_1k_input,
                matched_agent.price_per_1k_output,
                max_tokens,
            );
            for option in &mut requirements.accepts {
                option.extra.request_hash = Some(request_hash.clone());
            }
            if requested_rail_preference.is_some() {
                x402_service::filter_payment_requirements_for_rail(
                    &mut requirements,
                    requested_rail,
                );
            }
            if !x402_service::payment_requirements_have_options(&requirements) {
                return Ok(x402_service::build_no_payment_options_response(
                    requested_rail,
                    Some("no accepted payment option is currently available for this agent"),
                ));
            }
            return Ok(x402_service::build_402_response(&requirements));
        }
    };

    // Decode and parse payment proof
    let proof_bytes = STANDARD
        .decode(payment_header)
        .map_err(|_| CloudError::PaymentRequired("invalid payment proof: bad base64".into()))?;
    let proof: x402_service::PaymentProof = serde_json::from_slice(&proof_bytes)
        .map_err(|e| CloudError::PaymentRequired(format!("invalid payment proof: {e}")))?;

    if requested_rail_preference.is_some()
        && !x402_service::proof_matches_rail(&proof, requested_rail)
    {
        if requested_rail == x402_service::PaymentRailKind::ShieldedStablecoin
            || requested_rail == x402_service::PaymentRailKind::PrivateShieldedAuto
        {
            return Ok(x402_service::build_shielded_fallback_rejected_response());
        }
        return Err(CloudError::PaymentRequired(
            "payment proof does not match requested payment rail".into(),
        ));
    }
    if x402_service::proof_matches_rail(&proof, x402_service::PaymentRailKind::PrivateShieldedAuto)
    {
        x402_service::validate_payment_request_hash(&proof, &request_hash)?;
    }

    // Verify payment on-chain
    let verified = x402_service::verify_payment(
        state,
        &proof,
        required_amount,
        agent_info.id,
        matched_agent.provider_id,
        &matched_agent.model_id,
    )
    .await?;

    // Payment verified — dispatch opaque sealed inference to the relay.
    // The cloud cannot inspect the prompt or response; the sealed envelope
    // must contain the model/messages/agent context the enclave needs.
    let job_id = req
        .sealed_job_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let inference_result = match compute_service::dispatch_inference_sealed(
        state,
        &enclave_key_id,
        &sealed_request_b64,
        &job_id,
    )
    .await
    {
        Ok(result) => result,
        Err(e) => {
            // Mark payment as failed — client can retry with same tx_signature
            sqlx::query("UPDATE x402_payments SET status = 'failed' WHERE id = $1")
                .bind(verified.payment_id)
                .execute(&state.db)
                .await
                .ok();

            let body = serde_json::json!({
                "error": format!("inference failed: {e}"),
                "payment_id": verified.payment_id,
                "tx_signature": verified.tx_signature,
                "retry": "resubmit the same request with the same PAYMENT-SIGNATURE to retry"
            });
            return Ok((
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(body),
            )
                .into_response());
        }
    };

    let completion = SealedChatCompletion {
        id: format!("sealedcmpl-{}", inference_result.job_id),
        object: "sealed.chat.completion",
        created: Utc::now().timestamp(),
        model: model_str.to_string(),
        ciphertext_b64: inference_result.ciphertext_b64,
        is_final: inference_result.is_final,
        ghola: SealedChatMetadata {
            prompt_confidentiality: "sealed_inference",
            payment_privacy_scope: "settlement_metadata_only",
            enclave_key_id: enclave_key_id.clone(),
            relay_sealed: true,
        },
    };

    // Settle payment in background (85/15 split)
    let actual_input = 500_i32;
    let actual_output = max_tokens as i32;
    let latency = inference_result.latency_ms as i32;
    let price_in = matched_agent.price_per_1k_input;
    let price_out = matched_agent.price_per_1k_output;
    let payment_id = verified.payment_id;
    let provider_id = matched_agent.provider_id;
    let db = state.db.clone();
    tokio::spawn(async move {
        let _ = x402_service::settle_x402_payment(
            &db,
            payment_id,
            actual_input,
            actual_output,
            latency,
            price_in,
            price_out,
        )
        .await;
        let _ =
            compute_service::update_reputation(&db, provider_id, true, Some(latency as i64)).await;
    });

    // Build PAYMENT-RESPONSE header
    let actual_cost = verified.amount_usdc;
    let payment_response = x402_service::PaymentResponse {
        x402_version: 2,
        settled: true,
        actual_cost,
        tx_signature: verified.tx_signature,
        settlement_rail: verified.settlement_rail,
        privacy_disclosure: verified.privacy_disclosure,
        currency: verified.currency,
    };
    let pr_json = serde_json::to_vec(&payment_response).unwrap_or_default();
    let pr_b64 = STANDARD.encode(&pr_json);

    Ok((
        [
            (
                axum::http::header::HeaderName::from_static("payment-response"),
                pr_b64.clone(),
            ),
            (
                axum::http::header::HeaderName::from_static("x-payment-response"),
                pr_b64,
            ),
        ],
        Json(completion),
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// Authenticated flows (existing)
// ---------------------------------------------------------------------------

async fn chat_completions_non_stream(
    state: AppState,
    claims: Claims,
    req: ChatCompletionRequest,
) -> Result<Json<ChatCompletion>, CloudError> {
    let config = llm_router::get_user_llm_config(&state, claims.sub).await?;
    let model_name = response_model_name(req.model.as_deref(), &config.model);

    // Build messages for the LLM
    let mut system = None;
    let mut messages: Vec<ChatMsg> = Vec::new();
    for msg in &req.messages {
        if msg.role == "system" {
            system = Some(msg.content.clone());
        } else {
            messages.push(ChatMsg {
                role: msg.role.clone(),
                content: msg.content.clone(),
            });
        }
    }

    // Generate using streaming internally, collect full response
    let mut text_stream =
        llm_router::generate_stream(&state, claims.sub, &messages, system.as_deref()).await?;

    let mut full_response = String::new();
    while let Some(result) = text_stream.next().await {
        match result {
            Ok(text) => full_response.push_str(&text),
            Err(e) => return Err(e),
        }
    }

    // Rough token estimate
    let prompt_tokens = req
        .messages
        .iter()
        .map(|m| m.content.len() / 4)
        .sum::<usize>() as u32;
    let completion_tokens = (full_response.len() / 4) as u32;

    Ok(Json(ChatCompletion {
        id: format!("chatcmpl-{}", Uuid::new_v4()),
        object: "chat.completion",
        created: Utc::now().timestamp(),
        model: model_name,
        choices: vec![Choice {
            index: 0,
            message: ChoiceMessage {
                role: "assistant",
                content: full_response,
            },
            finish_reason: "stop",
        }],
        usage: Usage {
            prompt_tokens,
            completion_tokens,
            total_tokens: prompt_tokens + completion_tokens,
        },
    }))
}

async fn chat_completions_stream(
    state: AppState,
    claims: Claims,
    req: ChatCompletionRequest,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, CloudError> {
    let config = llm_router::get_user_llm_config(&state, claims.sub).await?;
    let model_name = response_model_name(req.model.as_deref(), &config.model);

    let mut system = None;
    let mut messages: Vec<ChatMsg> = Vec::new();
    for msg in &req.messages {
        if msg.role == "system" {
            system = Some(msg.content.clone());
        } else {
            messages.push(ChatMsg {
                role: msg.role.clone(),
                content: msg.content.clone(),
            });
        }
    }

    let text_stream =
        llm_router::generate_stream(&state, claims.sub, &messages, system.as_deref()).await?;

    let completion_id = format!("chatcmpl-{}", Uuid::new_v4());
    let created = Utc::now().timestamp();

    let sse_stream = async_stream::stream! {
        let mut text_stream = text_stream;
        while let Some(result) = text_stream.next().await {
            match result {
                Ok(text) => {
                    let chunk = serde_json::json!({
                        "id": &completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": &model_name,
                        "choices": [{
                            "index": 0,
                            "delta": { "content": text },
                            "finish_reason": null
                        }]
                    });
                    yield Ok(Event::default().data(chunk.to_string()));
                }
                Err(_) => break,
            }
        }

        // Final chunk with finish_reason
        let done_chunk = serde_json::json!({
            "id": &completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": &model_name,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": "stop"
            }]
        });
        yield Ok(Event::default().data(done_chunk.to_string()));
        yield Ok(Event::default().data("[DONE]".to_string()));
    };

    Ok(Sse::new(sse_stream))
}

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

pub async fn list_models() -> Result<Json<ModelList>, CloudError> {
    Ok(Json(ModelList {
        object: "list",
        data: canonical_models(),
    }))
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};
    use serde_json::Value;

    use super::*;

    #[test]
    fn payment_proof_header_accepts_x402_aliases() {
        for name in PAYMENT_PROOF_HEADER_ALIASES {
            let mut headers = HeaderMap::new();
            headers.insert(*name, HeaderValue::from_static("proof"));
            assert_eq!(payment_proof_header(&headers), Some("proof"));
        }
    }

    #[test]
    fn payment_rail_header_accepts_rail_aliases() {
        for name in PAYMENT_RAIL_HEADER_ALIASES {
            let mut headers = HeaderMap::new();
            headers.insert(*name, HeaderValue::from_static("private_usdcx"));
            assert_eq!(payment_rail_header(&headers), Some("private_usdcx"));
        }
    }

    #[test]
    fn canonical_models_advertise_private_local_and_agent_routes() {
        let models = canonical_models();
        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                GHOLA_PRIVATE_MODEL,
                GHOLA_LOCAL_MODEL,
                GHOLA_OPEN_MODEL,
                "agent:*"
            ]
        );

        let payload = serde_json::to_value(ModelList {
            object: "list",
            data: models,
        })
        .unwrap();
        let data = payload["data"].as_array().unwrap();
        let private = data
            .iter()
            .find(|model| model["id"] == GHOLA_PRIVATE_MODEL)
            .unwrap();

        assert_eq!(private["object"], "model");
        assert_eq!(private["owned_by"], "ghola");
        assert_eq!(private["ghola"]["receipts"], true);
        assert_eq!(
            private["ghola"]["prompt_confidentiality"],
            "sealed_or_local_required"
        );
        assert_eq!(
            private["ghola"]["payment_privacy_scope"],
            "shielded_payment_available"
        );
        assert!(private["ghola"]["privacy_boundary"]
            .as_str()
            .unwrap()
            .contains("Plaintext remote provider execution is disabled"));
        assert_eq!(
            private["ghola"]["payment_rails"],
            Value::Array(vec![
                Value::String("private_shielded_auto".to_string()),
                Value::String("aleo_usdcx_shielded".to_string()),
                Value::String("railgun_evm_shielded".to_string()),
                Value::String("solana_shielded_pool".to_string()),
            ])
        );
    }

    #[test]
    fn ghola_model_helpers_preserve_contract_boundaries() {
        assert!(is_agent_model(Some("agent:research-bot")));
        assert!(!is_agent_model(Some(GHOLA_PRIVATE_MODEL)));
        assert!(is_local_model(Some(GHOLA_LOCAL_MODEL)));
        assert!(is_supported_public_model(None));
        assert!(is_supported_public_model(Some(GHOLA_PRIVATE_MODEL)));
        assert!(is_supported_public_model(Some(GHOLA_LOCAL_MODEL)));
        assert!(is_supported_public_model(Some(GHOLA_OPEN_MODEL)));
        assert!(is_supported_public_model(Some("agent:research-bot")));
        assert!(!is_supported_public_model(Some("claude-sonnet-4")));
        assert_eq!(
            response_model_name(None, "claude-sonnet-4"),
            GHOLA_PRIVATE_MODEL
        );
        assert_eq!(
            response_model_name(Some(GHOLA_PRIVATE_MODEL), "claude-sonnet-4"),
            GHOLA_PRIVATE_MODEL
        );
        assert_eq!(
            response_model_name(Some(GHOLA_OPEN_MODEL), "claude-sonnet-4"),
            "claude-sonnet-4"
        );
        assert_eq!(
            response_model_name(Some("agent:research-bot"), "claude-sonnet-4"),
            "agent:research-bot"
        );
        assert_eq!(
            response_model_name(Some("claude-sonnet-4"), "claude-sonnet-4"),
            "claude-sonnet-4"
        );
    }

    #[test]
    fn sealed_remote_request_requires_ciphertext_only_body() {
        let missing = ChatCompletionRequest {
            messages: vec![],
            model: Some("agent:research-bot".to_string()),
            stream: None,
            max_tokens: None,
            temperature: None,
            enclave_key_id: None,
            sealed_request_b64: None,
            sealed_job_id: None,
            approval: PrivacyApproval::default(),
        };
        assert!(require_sealed_remote_request(&missing)
            .unwrap_err()
            .to_string()
            .contains("sealed_request_b64"));

        let plaintext = ChatCompletionRequest {
            messages: vec![MessageInput {
                role: "user".to_string(),
                content: "leak".to_string(),
            }],
            enclave_key_id: Some("enclave".to_string()),
            sealed_request_b64: Some("ciphertext".to_string()),
            ..missing
        };
        assert!(require_sealed_remote_request(&plaintext)
            .unwrap_err()
            .to_string()
            .contains("must not include plaintext messages"));

        let sealed = ChatCompletionRequest {
            messages: vec![],
            enclave_key_id: Some("enclave".to_string()),
            sealed_request_b64: Some("ciphertext".to_string()),
            ..plaintext
        };
        require_sealed_remote_request(&sealed).unwrap();
    }
}
