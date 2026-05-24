//! Agent ownership routes — multi-agent per user.
//!
//! A user can create N agents. Each agent is a first-class entity with:
//!   - its own DID (`did:key:z...` from a fresh ed25519 keypair)
//!   - its own dedicated `agent_wallets` row (linked via `wallet_id`)
//!   - its own service listings (filtered by `service_listings.agent_id`)
//!   - its own reputation row (filtered by `reputation_scores.agent_id` or
//!     by `entity_did = agent.did`)
//!
//! Naming note: this module's `create_agent` is distinct from
//! `routes::payments::create_agent` (which creates wallet-only spending agents)
//! and `routes::chat::create_agent` (which creates encrypted chat persona configs).
//! Always use the fully-qualified path `routes::agents::*` when wiring routes.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use base64::Engine;
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::Claims;
use crate::db::{DbAgent, DbAgentWallet, DbPaymentTransaction};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

// ── Request / Response Types ──

#[derive(Debug, Deserialize)]
pub struct CreateAgentRequest {
    pub slug: String,
    pub display_name: String,
    pub bio: Option<String>,
    pub avatar_url: Option<String>,
    /// Optional client-owned Ed25519 public key, base58 encoded. When present,
    /// said-cloud verifies `client_identity_signature` and uses this identity
    /// instead of minting an agent key on the server.
    pub client_pubkey: Option<String>,
    pub client_did: Option<String>,
    pub client_identity_message: Option<String>,
    pub client_identity_signature: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAgentRequest {
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub avatar_url: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AgentResponse {
    pub id: Uuid,
    pub user_id: Uuid,
    pub slug: String,
    pub display_name: String,
    pub bio: Option<String>,
    pub avatar_url: Option<String>,
    pub did: String,
    pub solana_address: String,
    pub wallet_id: Option<Uuid>,
    pub onchain_identity_pda: Option<String>,
    pub status: String,
    pub identity_mode: String,
    pub private_config_synced: bool,
    pub private_chat_agent_id: Option<Uuid>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

impl AgentResponse {
    fn from_agent(
        a: DbAgent,
        client_owned_identity: bool,
        private_chat_agent_id: Option<Uuid>,
    ) -> Self {
        let private_config_synced = private_chat_agent_id.is_some();
        Self {
            id: a.id,
            user_id: a.user_id,
            slug: a.slug,
            display_name: a.display_name,
            bio: a.bio,
            avatar_url: a.avatar_url,
            did: a.did,
            solana_address: a.solana_address,
            wallet_id: a.wallet_id,
            onchain_identity_pda: a.onchain_identity_pda,
            status: a.status,
            identity_mode: if client_owned_identity || private_config_synced {
                "seed_vault_derived".into()
            } else {
                "server_issued".into()
            },
            private_config_synced,
            private_chat_agent_id,
            created_at: a.created_at,
            updated_at: a.updated_at,
        }
    }
}

impl From<DbAgent> for AgentResponse {
    fn from(a: DbAgent) -> Self {
        Self::from_agent(a, false, None)
    }
}

#[derive(Debug, Serialize)]
pub struct AgentDetailResponse {
    #[serde(flatten)]
    pub agent: AgentResponse,
    pub wallet: Option<DbAgentWallet>,
    pub service_count: i64,
    pub reputation_score: Option<f32>,
}

#[derive(Debug, Serialize)]
pub struct EarningsResponse {
    pub agent_id: Uuid,
    pub total_received_micro_usdc: i64,
    pub total_spent_micro_usdc: i64,
    pub net_micro_usdc: i64,
    pub transaction_count: i64,
}

#[derive(Debug, Deserialize)]
pub struct TransactionsQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct TransactionResponse {
    pub id: Uuid,
    pub signature: String,
    pub direction: String,
    pub currency: String,
    pub amount: i64,
    pub recipient: String,
    pub sender: String,
    pub memo: Option<String>,
    pub status: String,
    pub helius_type: Option<String>,
    pub helius_source: Option<String>,
    pub description: Option<String>,
    pub block_time: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl From<DbPaymentTransaction> for TransactionResponse {
    fn from(t: DbPaymentTransaction) -> Self {
        Self {
            id: t.id,
            signature: t.signature,
            direction: t.direction,
            currency: t.currency,
            amount: t.amount,
            recipient: t.recipient,
            sender: t.sender,
            memo: t.memo,
            status: t.status,
            helius_type: t.helius_type,
            helius_source: t.helius_source,
            description: t.description,
            block_time: t.block_time,
            created_at: t.created_at,
        }
    }
}

// ── Helpers ──

fn user_id_from_claims(claims: &Claims) -> AppResult<Uuid> {
    claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user id in token".into()))
}

fn validate_slug(slug: &str) -> AppResult<()> {
    if slug.is_empty() || slug.len() > 64 {
        return Err(AppError::BadRequest("slug must be 1-64 characters".into()));
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::BadRequest(
            "slug must contain only letters, digits, '-', or '_'".into(),
        ));
    }
    Ok(())
}

/// Encode an ed25519 public key as a `did:key:z...` (multicodec ed25519-pub).
fn encode_did_key(pubkey: &[u8; 32]) -> String {
    // multicodec ed25519-pub = 0xed, 0x01
    let mut multi = vec![0xed, 0x01];
    multi.extend_from_slice(pubkey);
    format!("did:key:z{}", bs58::encode(&multi).into_string())
}

/// A Solana address is just the ed25519 public key encoded in base58.
fn solana_address_from_pubkey(pubkey: &[u8; 32]) -> String {
    bs58::encode(pubkey).into_string()
}

fn client_owned_pubkey(req: &CreateAgentRequest) -> AppResult<Option<[u8; 32]>> {
    let Some(client_pubkey) = req.client_pubkey.as_deref() else {
        return Ok(None);
    };
    let pubkey_vec = bs58::decode(client_pubkey)
        .into_vec()
        .map_err(|e| AppError::BadRequest(format!("invalid client_pubkey: {e}")))?;
    let pubkey_bytes: [u8; 32] = pubkey_vec
        .as_slice()
        .try_into()
        .map_err(|_| AppError::BadRequest("client_pubkey must be 32 bytes".into()))?;

    let expected_did = encode_did_key(&pubkey_bytes);
    let expected_address = solana_address_from_pubkey(&pubkey_bytes);
    if req.client_did.as_deref() != Some(expected_did.as_str()) {
        return Err(AppError::BadRequest(
            "client_did does not match client_pubkey".into(),
        ));
    }

    let message = req
        .client_identity_message
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("client_identity_message is required".into()))?;
    let signature = req
        .client_identity_signature
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("client_identity_signature is required".into()))?;
    let signature = base64::engine::general_purpose::STANDARD
        .decode(signature)
        .map_err(|_| AppError::BadRequest("invalid client_identity_signature base64".into()))?;
    let sig_bytes: [u8; 64] = signature
        .as_slice()
        .try_into()
        .map_err(|_| AppError::BadRequest("client_identity_signature must be 64 bytes".into()))?;
    let verifying_key = VerifyingKey::from_bytes(&pubkey_bytes)
        .map_err(|e| AppError::BadRequest(format!("invalid client_pubkey: {e}")))?;
    let sig = Signature::from_bytes(&sig_bytes);
    verifying_key
        .verify(message.as_bytes(), &sig)
        .map_err(|_| AppError::Unauthorized("client agent signature verification failed".into()))?;

    let signed: serde_json::Value = serde_json::from_str(message)
        .map_err(|_| AppError::BadRequest("client_identity_message must be JSON".into()))?;
    if signed.get("domain").and_then(|v| v.as_str()) != Some("ghola-agent-create-v1")
        || signed.get("slug").and_then(|v| v.as_str()) != Some(req.slug.as_str())
        || signed.get("display_name").and_then(|v| v.as_str()) != Some(req.display_name.as_str())
        || signed.get("bio").and_then(|v| v.as_str()) != Some(req.bio.as_deref().unwrap_or(""))
        || signed.get("did").and_then(|v| v.as_str()) != Some(expected_did.as_str())
        || signed.get("solana_address").and_then(|v| v.as_str()) != Some(expected_address.as_str())
    {
        return Err(AppError::BadRequest(
            "client_identity_message does not match create-agent request".into(),
        ));
    }

    Ok(Some(pubkey_bytes))
}

// ── Handlers ──

/// POST /v1/agents — create a new agent owned by the authenticated user.
///
/// Generates a fresh ed25519 keypair, derives the DID and Solana address,
/// inserts the `agents` row, provisions a dedicated `agent_wallets` row,
/// and links the two via `wallet_id`.
pub async fn create_agent(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateAgentRequest>,
) -> AppResult<(StatusCode, Json<AgentResponse>)> {
    let user_id = user_id_from_claims(&claims)?;

    validate_slug(&req.slug)?;
    if req.display_name.trim().is_empty() {
        return Err(AppError::BadRequest("display_name is required".into()));
    }

    // Per-user rate limit on agent creation
    if let Err(retry_after) = state
        .rate_limiter
        .check(&format!("agent_create:{user_id}"), 10)
    {
        return Err(AppError::TooManyRequests(retry_after));
    }

    // Reject duplicate slug for this user up front (unique constraint also enforces it)
    let existing: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM agents WHERE user_id = $1 AND slug = $2")
            .bind(user_id)
            .bind(&req.slug)
            .fetch_optional(&state.db)
            .await?;
    if existing.is_some() {
        return Err(AppError::Conflict(format!(
            "agent with slug '{}' already exists",
            req.slug
        )));
    }

    // Generate cryptographic identity unless a Seeker/client-owned identity
    // was supplied and proven by a detached Ed25519 signature.
    let client_owned_identity = req.client_pubkey.is_some();
    let pub_bytes: [u8; 32] = match client_owned_pubkey(&req)? {
        Some(pubkey) => pubkey,
        None => SigningKey::generate(&mut OsRng).verifying_key().to_bytes(),
    };
    let did = encode_did_key(&pub_bytes);
    let solana_address = solana_address_from_pubkey(&pub_bytes);

    // All-or-nothing: agent + wallet must be created atomically
    let mut tx = state.db.begin().await?;

    let agent: DbAgent = sqlx::query_as(
        r#"INSERT INTO agents
            (user_id, slug, display_name, bio, avatar_url, did, master_pubkey, solana_address, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
           RETURNING *"#,
    )
    .bind(user_id)
    .bind(&req.slug)
    .bind(&req.display_name)
    .bind(req.bio.as_deref())
    .bind(req.avatar_url.as_deref())
    .bind(&did)
    .bind(pub_bytes.to_vec())
    .bind(&solana_address)
    .fetch_one(&mut *tx)
    .await?;

    // Provision a dedicated wallet row for this agent.
    // hd_index is sequential per user (matching the existing payments.rs convention).
    let max_index: Option<i32> =
        sqlx::query_scalar("SELECT MAX(hd_index) FROM agent_wallets WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;
    let next_index = max_index.map_or(0, |m| m + 1);

    let wallet: DbAgentWallet = sqlx::query_as(
        r#"INSERT INTO agent_wallets
            (user_id, label, hd_index, solana_address, spending_policy, agent_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *"#,
    )
    .bind(user_id)
    .bind(&req.slug)
    .bind(next_index)
    .bind(&solana_address)
    .bind(serde_json::json!({}))
    .bind(agent.id)
    .fetch_one(&mut *tx)
    .await?;

    // Link the wallet back into the agent row
    let agent: DbAgent =
        sqlx::query_as("UPDATE agents SET wallet_id = $1 WHERE id = $2 RETURNING *")
            .bind(wallet.id)
            .bind(agent.id)
            .fetch_one(&mut *tx)
            .await?;

    tx.commit().await?;

    // Add the new agent's wallet to the Helius watchlist so its on-chain
    // activity streams into payment_transactions. Spawned because the
    // Helius round-trip is ~150ms and we don't want to block the
    // create-agent response on a third-party API. Reconcile on startup
    // covers the case where this task fails (e.g. transient network).
    if state.config.helius_enabled() {
        let bg_state = state.clone();
        let address = solana_address.clone();
        tokio::spawn(async move {
            let Some(client) = crate::helius::Helius::new(&bg_state.http_client, &bg_state.config)
            else {
                return;
            };
            if let Err(e) = client.add_address(&address).await {
                tracing::warn!(wallet = %address, "helius add_address failed: {e}");
            }
        });
    }

    Ok((
        StatusCode::CREATED,
        Json(AgentResponse::from_agent(
            agent,
            client_owned_identity,
            None,
        )),
    ))
}

/// GET /v1/agents — list all agents owned by the authenticated user.
pub async fn list_agents(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
) -> AppResult<Json<Vec<AgentResponse>>> {
    let user_id = user_id_from_claims(&claims)?;

    let agents: Vec<DbAgent> = sqlx::query_as(
        "SELECT * FROM agents WHERE user_id = $1 AND status != 'archived' ORDER BY created_at DESC",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    let private_rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
        r#"SELECT public_agent_id, id
           FROM chat_agents
           WHERE user_id = $1 AND public_agent_id IS NOT NULL
           ORDER BY created_at DESC"#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    let private_by_agent: HashMap<Uuid, Uuid> = private_rows.into_iter().collect();

    Ok(Json(
        agents
            .into_iter()
            .map(|agent| {
                let private_chat_agent_id = private_by_agent.get(&agent.id).copied();
                AgentResponse::from_agent(agent, false, private_chat_agent_id)
            })
            .collect(),
    ))
}

/// GET /v1/agents/:id — full detail with wallet, service count, and reputation.
pub async fn get_agent(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<AgentDetailResponse>> {
    let user_id = user_id_from_claims(&claims)?;

    let agent: DbAgent = sqlx::query_as("SELECT * FROM agents WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("agent not found".into()))?;

    let wallet: Option<DbAgentWallet> = if let Some(wid) = agent.wallet_id {
        sqlx::query_as("SELECT * FROM agent_wallets WHERE id = $1")
            .bind(wid)
            .fetch_optional(&state.db)
            .await?
    } else {
        None
    };

    let service_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM service_listings WHERE agent_id = $1")
            .bind(id)
            .fetch_one(&state.db)
            .await?;

    let reputation_score: Option<f32> =
        sqlx::query_scalar("SELECT overall_score FROM reputation_scores WHERE entity_did = $1")
            .bind(&agent.did)
            .fetch_optional(&state.db)
            .await?;

    let private_chat_agent_id: Option<Uuid> = sqlx::query_scalar(
        r#"SELECT id
           FROM chat_agents
           WHERE user_id = $1 AND public_agent_id = $2
           ORDER BY created_at DESC
           LIMIT 1"#,
    )
    .bind(user_id)
    .bind(id)
    .fetch_optional(&state.db)
    .await?;

    Ok(Json(AgentDetailResponse {
        agent: AgentResponse::from_agent(agent, false, private_chat_agent_id),
        wallet,
        service_count,
        reputation_score,
    }))
}

/// PATCH /v1/agents/:id — update display fields and status.
pub async fn update_agent(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateAgentRequest>,
) -> AppResult<Json<AgentResponse>> {
    let user_id = user_id_from_claims(&claims)?;

    // Verify ownership before any update
    let existing: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM agents WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;
    if existing.is_none() {
        return Err(AppError::NotFound("agent not found".into()));
    }

    if let Some(ref status) = req.status {
        if !matches!(status.as_str(), "active" | "paused" | "archived") {
            return Err(AppError::BadRequest(
                "status must be one of: active, paused, archived".into(),
            ));
        }
    }

    let agent: DbAgent = sqlx::query_as(
        r#"UPDATE agents SET
            display_name = COALESCE($1, display_name),
            bio          = COALESCE($2, bio),
            avatar_url   = COALESCE($3, avatar_url),
            status       = COALESCE($4, status)
           WHERE id = $5 AND user_id = $6
           RETURNING *"#,
    )
    .bind(req.display_name.as_deref())
    .bind(req.bio.as_deref())
    .bind(req.avatar_url.as_deref())
    .bind(req.status.as_deref())
    .bind(id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(agent.into()))
}

/// DELETE /v1/agents/:id — soft-archive the agent (status='archived').
///
/// We never hard-delete, because the DID, wallet history, and reputation events
/// are permanent records.
pub async fn delete_agent(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let user_id = user_id_from_claims(&claims)?;

    // Capture the wallet address before we flip the status so we can
    // remove it from the Helius watchlist after the DB commit succeeds.
    let solana_address: Option<String> =
        sqlx::query_scalar("SELECT solana_address FROM agents WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;

    let result =
        sqlx::query("UPDATE agents SET status = 'archived' WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .execute(&state.db)
            .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("agent not found".into()));
    }

    // Also flip the wallet's `active` flag so the inbound webhook
    // receiver drops events for it (the watchlist mutation below is
    // best-effort; this DB state is the source of truth).
    let _ = sqlx::query("UPDATE agent_wallets SET active = false WHERE agent_id = $1")
        .bind(id)
        .execute(&state.db)
        .await;

    if let Some(address) = solana_address {
        if state.config.helius_enabled() {
            let bg_state = state.clone();
            tokio::spawn(async move {
                let Some(client) =
                    crate::helius::Helius::new(&bg_state.http_client, &bg_state.config)
                else {
                    return;
                };
                if let Err(e) = client.remove_address(&address).await {
                    tracing::warn!(wallet = %address, "helius remove_address failed: {e}");
                }
            });
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

/// GET /v1/agents/:id/wallet — wallet info for the agent.
pub async fn get_agent_wallet(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<DbAgentWallet>> {
    let user_id = user_id_from_claims(&claims)?;

    let wallet: Option<DbAgentWallet> = sqlx::query_as(
        r#"SELECT w.* FROM agent_wallets w
           JOIN agents a ON a.wallet_id = w.id
           WHERE a.id = $1 AND a.user_id = $2"#,
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    wallet
        .map(Json)
        .ok_or_else(|| AppError::NotFound("agent wallet not found".into()))
}

/// GET /v1/agents/:id/services — list services owned by this agent.
pub async fn list_agent_services(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let user_id = user_id_from_claims(&claims)?;

    // Confirm ownership
    let owns: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM agents WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;
    if owns.is_none() {
        return Err(AppError::NotFound("agent not found".into()));
    }

    let rows: Vec<serde_json::Value> = sqlx::query_scalar(
        r#"SELECT to_jsonb(s.*) FROM service_listings s WHERE s.agent_id = $1 ORDER BY s.created_at DESC"#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct CreateAgentServiceRequest {
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
    pub base_url: String,
    pub health_check_url: Option<String>,
    pub openapi_url: Option<String>,
    pub auth_type: Option<String>,
    pub pricing_model: Option<String>,
    pub price_micro_usdc: Option<i64>,
    pub free_tier_requests: Option<i32>,
    pub sla_uptime_percent: Option<f32>,
    pub regions: Option<Vec<String>>,
    pub receive_address: Option<String>,
    pub platform_fee_bps: Option<i32>,
}

/// POST /v1/agents/:id/services — register a new service listing under this agent.
///
/// Mirrors `routes::services::register_service` but pre-binds `agent_id` and uses
/// the agent's DID as `owner_did`.
pub async fn create_agent_service(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<CreateAgentServiceRequest>,
) -> AppResult<(StatusCode, Json<serde_json::Value>)> {
    let user_id = user_id_from_claims(&claims)?;

    let agent: DbAgent = sqlx::query_as("SELECT * FROM agents WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("agent not found".into()))?;

    if req.name.trim().is_empty() || req.slug.trim().is_empty() || req.base_url.trim().is_empty() {
        return Err(AppError::BadRequest(
            "name, slug, and base_url are required".into(),
        ));
    }

    // receive_address defaults to the agent's own Solana address (so payments
    // flow directly into the agent wallet)
    let receive_address = req
        .receive_address
        .unwrap_or_else(|| agent.solana_address.clone());

    let row: serde_json::Value = sqlx::query_scalar(
        r#"INSERT INTO service_listings
            (owner_id, owner_did, agent_id, name, slug, description, category, tags,
             base_url, health_check_url, openapi_url, auth_type, pricing_model,
             price_micro_usdc, free_tier_requests, sla_uptime_percent, regions,
             receive_address, platform_fee_bps)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                   $9, $10, $11,
                   COALESCE($12::service_auth_type, 'api_key'::service_auth_type),
                   COALESCE($13::pricing_model, 'per_request'::pricing_model),
                   $14, $15, $16, $17, $18, $19)
           RETURNING to_jsonb(service_listings.*)"#,
    )
    .bind(user_id)
    .bind(&agent.did)
    .bind(agent.id)
    .bind(&req.name)
    .bind(&req.slug)
    .bind(req.description.unwrap_or_default())
    .bind(req.category.unwrap_or_else(|| "general".into()))
    .bind(req.tags.unwrap_or_default())
    .bind(&req.base_url)
    .bind(req.health_check_url.as_deref())
    .bind(req.openapi_url.as_deref())
    .bind(req.auth_type.as_deref())
    .bind(req.pricing_model.as_deref())
    .bind(req.price_micro_usdc.unwrap_or(0))
    .bind(req.free_tier_requests.unwrap_or(0))
    .bind(req.sla_uptime_percent)
    .bind(req.regions.unwrap_or_default())
    .bind(&receive_address)
    .bind(req.platform_fee_bps.unwrap_or(300))
    .fetch_one(&state.db)
    .await?;

    Ok((StatusCode::CREATED, Json(row)))
}

/// GET /v1/agents/:id/reputation — reputation score keyed by the agent's DID.
pub async fn get_agent_reputation(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let user_id = user_id_from_claims(&claims)?;

    let agent: DbAgent = sqlx::query_as("SELECT * FROM agents WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("agent not found".into()))?;

    let row: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT to_jsonb(r.*) FROM reputation_scores r WHERE r.entity_did = $1")
            .bind(&agent.did)
            .fetch_optional(&state.db)
            .await?;

    // No row yet → return a zeroed scaffold so the frontend always gets valid JSON
    let payload = row.unwrap_or_else(|| {
        serde_json::json!({
            "entity_did": agent.did,
            "entity_type": "agent",
            "overall_score": 0.0,
            "confidence": 0.0,
            "total_transactions": 0,
            "completed_transactions": 0,
            "review_count": 0,
        })
    });

    Ok(Json(payload))
}

/// GET /v1/agents/:id/earnings — totals derived from `payment_transactions`
/// against the agent's wallet.
pub async fn get_agent_earnings(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<EarningsResponse>> {
    let user_id = user_id_from_claims(&claims)?;

    let agent: DbAgent = sqlx::query_as("SELECT * FROM agents WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("agent not found".into()))?;

    let wallet_id = match agent.wallet_id {
        Some(w) => w,
        None => {
            return Ok(Json(EarningsResponse {
                agent_id: agent.id,
                total_received_micro_usdc: 0,
                total_spent_micro_usdc: 0,
                net_micro_usdc: 0,
                transaction_count: 0,
            }));
        }
    };

    // payment_transactions.amount is in lamports for sol, micro-USDC for usdc.
    // Earnings story = USDC only.
    let received: Option<i64> = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(amount), 0)::BIGINT FROM payment_transactions
           WHERE agent_wallet_id = $1 AND direction = 'receive' AND currency = 'usdc'"#,
    )
    .bind(wallet_id)
    .fetch_one(&state.db)
    .await?;

    let spent: Option<i64> = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(amount), 0)::BIGINT FROM payment_transactions
           WHERE agent_wallet_id = $1 AND direction = 'send' AND currency = 'usdc'"#,
    )
    .bind(wallet_id)
    .fetch_one(&state.db)
    .await?;

    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM payment_transactions WHERE agent_wallet_id = $1")
            .bind(wallet_id)
            .fetch_one(&state.db)
            .await?;

    let received = received.unwrap_or(0);
    let spent = spent.unwrap_or(0);

    Ok(Json(EarningsResponse {
        agent_id: agent.id,
        total_received_micro_usdc: received,
        total_spent_micro_usdc: spent,
        net_micro_usdc: received - spent,
        transaction_count: count,
    }))
}

/// GET /v1/agents/:id/transactions — per-tx history from `payment_transactions`.
pub async fn get_agent_transactions(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Query(q): Query<TransactionsQuery>,
) -> AppResult<Json<Vec<TransactionResponse>>> {
    let user_id = user_id_from_claims(&claims)?;

    let agent: DbAgent = sqlx::query_as("SELECT * FROM agents WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("agent not found".into()))?;

    let wallet_id = match agent.wallet_id {
        Some(w) => w,
        None => return Ok(Json(Vec::new())),
    };

    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);

    let rows: Vec<DbPaymentTransaction> = sqlx::query_as(
        r#"SELECT * FROM payment_transactions
           WHERE agent_wallet_id = $1
           ORDER BY COALESCE(block_time, created_at) DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(wallet_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter().map(TransactionResponse::from).collect(),
    ))
}
