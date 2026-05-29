//! Additive agentic-commerce intent orchestration.
//! This owns the front user flow while delegating supply, pricing, and payment
//! details to existing x402/MCP rails.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

use crate::error::CloudError;
use crate::privacy::{
    record_privacy_audit_event, sensitive_text_hash, NetworkScope, PrivacyApproval,
};
use crate::services::{agent_service, compute_service, x402_service};
use crate::state::AppState;

const DEFAULT_BUDGET_MICRO_USDC: i64 = 5_000_000;
const MAX_BUDGET_MICRO_USDC: i64 = 500_000_000;
const QUOTE_TTL_MINUTES: i64 = 10;
const HOLD_TTL_MINUTES: i64 = 10;

#[derive(Debug, Deserialize)]
pub struct CreateIntentRequest {
    pub goal: String,
    pub budget_micro_usdc: Option<i64>,
    pub privacy_mode: Option<String>,
    pub preferred_rail: Option<String>,
    pub allowed_adapters: Option<Vec<String>>,
    pub deadline_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct CommerceIntent {
    pub id: Uuid,
    pub user_id: Uuid,
    pub goal: String,
    pub budget_micro_usdc: i64,
    pub privacy_mode: String,
    pub preferred_rail: String,
    pub allowed_adapters: Vec<String>,
    pub deadline_at: Option<DateTime<Utc>>,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct CommerceOffer {
    pub offer_id: String,
    pub adapter: String,
    pub title: String,
    pub description: String,
    pub merchant_label: String,
    pub merchant_type: String,
    pub offer_image_url: Option<String>,
    pub fulfillment_kind: String,
    pub trust_summary: String,
    pub provider_slug: String,
    pub model_id: String,
    pub tags: Vec<String>,
    pub tools: Vec<String>,
    pub provider_reputation: f64,
    pub amount_micro_usdc: i64,
    pub currency: String,
    pub rail: String,
    pub rail_options: Vec<CommerceRailOption>,
    pub privacy_disclosure: String,
    pub available: bool,
    pub unavailable_reason: Option<String>,
    pub raw_offer: Value,
}

#[derive(Debug, Serialize, Clone)]
pub struct CommerceRailOption {
    pub rail: String,
    pub label: String,
    pub available: bool,
    pub privacy_disclosure: String,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateQuoteRequest {
    pub offer_id: String,
    pub rail: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CommerceQuote {
    pub id: Uuid,
    pub intent_id: Uuid,
    pub adapter: String,
    pub offer_id: String,
    pub provider_slug: Option<String>,
    pub provider_label: Option<String>,
    pub amount_micro_usdc: i64,
    pub currency: String,
    pub rail: String,
    pub status: String,
    pub payment_requirements: Value,
    pub policy: Value,
    pub raw_offer: Value,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ExecuteQuoteRequest {
    pub quote_id: Uuid,
    #[serde(flatten)]
    pub approval: PrivacyApproval,
}

#[derive(Debug, Serialize)]
pub struct CommerceExecution {
    pub id: Uuid,
    pub intent_id: Uuid,
    pub quote_id: Uuid,
    pub status: String,
    pub handoff: Value,
    pub receipt: CommerceReceipt,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct CommerceReceipt {
    pub id: Uuid,
    pub execution_id: Uuid,
    pub status: String,
    pub adapter: String,
    pub amount_micro_usdc: i64,
    pub currency: String,
    pub rail: String,
    pub receipt: Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ExportCommerceReceiptRequest {
    pub reason: Option<String>,
    pub audience: Option<String>,
    #[serde(flatten)]
    pub approval: PrivacyApproval,
}

#[derive(Debug, Serialize)]
pub struct CommerceReceiptExport {
    pub receipt: CommerceReceipt,
    pub exported_at: DateTime<Utc>,
    pub audience: String,
    pub reason: Option<String>,
}

pub async fn create_intent(
    db: &PgPool,
    user_id: Uuid,
    req: CreateIntentRequest,
) -> Result<CommerceIntent, CloudError> {
    let goal = req.goal.trim();
    if goal.is_empty() || goal.len() > 1200 {
        return Err(CloudError::BadRequest(
            "goal must be between 1 and 1200 characters".into(),
        ));
    }

    let budget = req.budget_micro_usdc.unwrap_or(DEFAULT_BUDGET_MICRO_USDC);
    if !(1..=MAX_BUDGET_MICRO_USDC).contains(&budget) {
        return Err(CloudError::BadRequest(
            "budget_micro_usdc must be between 1 and 500000000".into(),
        ));
    }

    let privacy_mode = req.privacy_mode.unwrap_or_else(|| "private".to_string());
    if privacy_mode != "private" && privacy_mode != "open" {
        return Err(CloudError::BadRequest(
            "privacy_mode must be private or open".into(),
        ));
    }

    let preferred_rail = req.preferred_rail.unwrap_or_else(|| {
        if privacy_mode == "private" {
            "aleo_usdcx_shielded".to_string()
        } else {
            "solana_public_usdc".to_string()
        }
    });
    let allowed_adapters = normalize_adapters(req.allowed_adapters);

    let row = sqlx::query(
        r#"
        INSERT INTO commerce_intents
            (user_id, goal, budget_micro_usdc, privacy_mode, preferred_rail, allowed_adapters, deadline_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, user_id, goal, budget_micro_usdc, privacy_mode, preferred_rail,
                  allowed_adapters, deadline_at, status, created_at, updated_at
        "#,
    )
    .bind(user_id)
    .bind(goal)
    .bind(budget)
    .bind(&privacy_mode)
    .bind(&preferred_rail)
    .bind(&allowed_adapters)
    .bind(req.deadline_at)
    .fetch_one(db)
    .await?;

    Ok(row_to_intent(&row))
}

pub async fn get_intent(
    db: &PgPool,
    user_id: Uuid,
    intent_id: Uuid,
) -> Result<CommerceIntent, CloudError> {
    let row = sqlx::query(
        r#"
        SELECT id, user_id, goal, budget_micro_usdc, privacy_mode, preferred_rail,
               allowed_adapters, deadline_at, status, created_at, updated_at
        FROM commerce_intents
        WHERE id = $1 AND user_id = $2
        "#,
    )
    .bind(intent_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| CloudError::NotFound("commerce intent not found".into()))?;

    Ok(row_to_intent(&row))
}

pub async fn list_offers(
    state: &AppState,
    user_id: Uuid,
    intent_id: Uuid,
) -> Result<Vec<CommerceOffer>, CloudError> {
    let intent = get_intent(&state.db, user_id, intent_id).await?;
    let mut offers = Vec::new();

    if intent
        .allowed_adapters
        .iter()
        .any(|a| a == "fixture_catalog")
    {
        offers.extend(fixture_catalog_offers(&intent));
    }

    if intent
        .allowed_adapters
        .iter()
        .any(|a| a == "x402" || a == "x402_agent")
    {
        let pricing =
            x402_service::list_agent_pricing(&state.db, state, None, Some("rating")).await?;
        let shielded = x402_service::shielded_stablecoin_runtime_status();
        let private_requested = intent.privacy_mode == "private";
        let rail_options = rail_options(private_requested);
        for agent in pricing {
            let amount = agent.price_per_request_usdc;
            let available = !private_requested || shielded.ready;
            let (rail, privacy_disclosure, unavailable_reason) = if private_requested {
                (
                    x402_service::PaymentRailKind::ShieldedStablecoin
                        .as_str()
                        .to_string(),
                    shielded.privacy_disclosure.to_string(),
                    shielded.unavailable_reason.map(str::to_string),
                )
            } else {
                (
                    x402_service::PaymentRailKind::SolanaPublicStablecoin
                        .as_str()
                        .to_string(),
                    x402_service::PUBLIC_STABLECOIN_DISCLOSURE.to_string(),
                    None,
                )
            };

            offers.push(CommerceOffer {
                offer_id: format!("x402:{}", agent.slug),
                adapter: "x402_agent".to_string(),
                title: agent.display_name.clone(),
                description: agent.description.clone(),
                merchant_label: agent.display_name.clone(),
                merchant_type: "agent_service".to_string(),
                offer_image_url: None,
                fulfillment_kind: "agent_execution".to_string(),
                trust_summary: format!(
                    "x402 service · reputation {:.1}/5 · paid per successful run",
                    agent.provider_reputation
                ),
                provider_slug: agent.slug.clone(),
                model_id: agent.model_id.clone(),
                tags: agent.tags.clone(),
                tools: agent.tools.clone(),
                provider_reputation: agent.provider_reputation,
                amount_micro_usdc: amount,
                currency: "USDC".to_string(),
                rail,
                rail_options: rail_options.clone(),
                privacy_disclosure,
                available,
                unavailable_reason: if available { None } else { unavailable_reason },
                raw_offer: json!({
                    "redacted": true,
                    "source": "x402_agent",
                    "provider_slug": agent.slug,
                }),
            });
        }
    }

    if intent
        .allowed_adapters
        .iter()
        .any(|a| a == "merchant_checkout")
    {
        offers.push(merchant_checkout_placeholder(&intent));
    }

    sqlx::query("UPDATE commerce_intents SET status = 'offered', updated_at = now() WHERE id = $1")
        .bind(intent_id)
        .execute(&state.db)
        .await?;

    Ok(offers)
}

pub async fn create_quote(
    state: &AppState,
    user_id: Uuid,
    intent_id: Uuid,
    req: CreateQuoteRequest,
) -> Result<CommerceQuote, CloudError> {
    let intent = get_intent(&state.db, user_id, intent_id).await?;
    if req.offer_id.starts_with("fixture:") {
        return create_fixture_quote(state, user_id, intent, req).await;
    }

    let slug = req.offer_id.strip_prefix("x402:").ok_or_else(|| {
        CloudError::BadRequest("only fixture catalog and x402 offers are supported in v1".into())
    })?;

    let pricing = x402_service::get_agent_pricing(&state.db, state, slug).await?;
    let public_agent = agent_service::get_public_agent(&state.db, slug).await?;
    let amount = pricing.price_per_request_usdc;
    if amount > intent.budget_micro_usdc {
        return Err(CloudError::BadRequest(
            "selected offer exceeds intent budget".into(),
        ));
    }

    let requested_rail = if intent.privacy_mode == "private" {
        Some("shielded_stablecoin")
    } else {
        req.rail.as_deref()
    };
    let rail_kind = x402_service::parse_requested_payment_rail(requested_rail)?;
    if rail_kind == x402_service::PaymentRailKind::ShieldedStablecoin {
        let shielded = x402_service::shielded_stablecoin_runtime_status();
        if !shielded.ready {
            return Err(CloudError::PaymentRequired(format!(
                "private settlement unavailable: {}",
                shielded
                    .unavailable_reason
                    .unwrap_or("shielded stablecoin adapter is unavailable")
            )));
        }
    }

    let quote_id = Uuid::new_v4();
    let execute_resource = format!(
        "{}/api/commerce/intents/{}/execute",
        state.config.base_url.trim_end_matches('/'),
        intent.id
    );
    let requirements = x402_service::build_payment_requirements_for_resource(
        state,
        public_agent.id,
        &pricing.slug,
        &pricing.model_id,
        pricing.price_per_1k_input,
        pricing.price_per_1k_output,
        1000,
        &execute_resource,
        "POST",
        None,
        Some(&quote_id.to_string()),
    );
    let mut payment_requirements = serde_json::to_value(&requirements)
        .map_err(|e| CloudError::Internal(format!("serialize payment requirements failed: {e}")))?;
    retain_payment_rail(&mut payment_requirements, rail_kind.as_str());
    if payment_requirements
        .get("accepts")
        .and_then(Value::as_array)
        .map_or(true, Vec::is_empty)
    {
        return Err(CloudError::PaymentRequired(
            "no payment option is currently available for the selected rail".into(),
        ));
    }

    let expires_at = Utc::now() + Duration::minutes(QUOTE_TTL_MINUTES);
    let rail = rail_kind.canonical_rail().to_string();
    let policy = json!({
        "intent_id": intent.id,
        "quote_id": quote_id,
        "payment_identifier": quote_id,
        "budget_micro_usdc": intent.budget_micro_usdc,
        "privacy_mode": intent.privacy_mode,
        "preferred_rail": intent.preferred_rail,
        "adapter": "x402",
        "rail": rail,
        "fail_closed": intent.privacy_mode == "private",
        "fallback_allowed": intent.privacy_mode != "private",
        "expires_at": expires_at,
    });
    let raw_offer = json!({
        "redacted": true,
        "source": "x402_agent",
        "provider_slug": pricing.slug,
        "model_id": pricing.model_id,
    });

    let row = sqlx::query(
        r#"
        INSERT INTO commerce_quotes
            (id, intent_id, user_id, adapter, offer_id, provider_slug, provider_label,
             amount_micro_usdc, currency, rail, payment_requirements, policy, raw_offer, expires_at)
        VALUES ($1, $2, $3, 'x402_agent', $4, $5, $6, $7, 'USDC', $8, $9, $10, $11, $12)
        RETURNING id, intent_id, adapter, offer_id, provider_slug, provider_label,
                  amount_micro_usdc, currency, rail, status, payment_requirements,
                  policy, raw_offer, expires_at, created_at
        "#,
    )
    .bind(quote_id)
    .bind(intent_id)
    .bind(user_id)
    .bind(&req.offer_id)
    .bind(&public_agent.slug)
    .bind(&public_agent.display_name)
    .bind(amount)
    .bind(&rail)
    .bind(&payment_requirements)
    .bind(&policy)
    .bind(&raw_offer)
    .bind(expires_at)
    .fetch_one(&state.db)
    .await?;

    sqlx::query("UPDATE commerce_intents SET status = 'quoted', updated_at = now() WHERE id = $1")
        .bind(intent_id)
        .execute(&state.db)
        .await?;

    Ok(row_to_quote(&row))
}

pub async fn execute_quote(
    state: &AppState,
    user_id: Uuid,
    intent_id: Uuid,
    req: ExecuteQuoteRequest,
) -> Result<CommerceExecution, CloudError> {
    let approval = req
        .approval
        .require_and_store_for(NetworkScope::CommerceExecution)?;
    let intent = get_intent(&state.db, user_id, intent_id).await?;
    let quote = get_quote(&state.db, user_id, intent_id, req.quote_id).await?;

    if quote.expires_at < Utc::now() {
        return Err(CloudError::BadRequest("quote has expired".into()));
    }
    if quote.amount_micro_usdc > intent.budget_micro_usdc {
        return Err(CloudError::BadRequest("quote exceeds intent budget".into()));
    }
    if intent.privacy_mode == "private" {
        let shielded = x402_service::shielded_stablecoin_runtime_status();
        if !shielded.ready || !is_private_rail(&quote.rail) {
            return Err(CloudError::PaymentRequired(
                "private settlement is unavailable; execution failed closed".into(),
            ));
        }
    }

    if quote.adapter == "fixture_catalog" {
        return execute_fixture_quote(state, user_id, intent, quote, approval, &req.approval).await;
    }

    let reserve = json!({
        "kind": "ghola_balance_reserved",
        "intent_id": intent.id,
        "quote_id": quote.id,
        "adapter": quote.adapter,
        "offer_id": quote.offer_id,
        "provider_slug": quote.provider_slug,
        "amount_micro_usdc": quote.amount_micro_usdc,
        "currency": quote.currency,
        "rail": quote.rail,
        "payment_requirements_redacted": true,
        "policy": quote.policy,
        "next_action": "execute_agent",
        "expires_in_minutes": HOLD_TTL_MINUTES,
    });

    let mut tx = state.db.begin().await?;
    lock_user_balance(&mut tx, user_id).await?;
    expire_stale_holds(&mut tx, user_id).await?;
    let available = available_private_balance(&mut tx, user_id).await?;
    if available < quote.amount_micro_usdc {
        return Err(CloudError::PaymentRequired(format!(
            "Ghola balance is below quoted amount: need {} micro-USDC, available {}",
            quote.amount_micro_usdc, available
        )));
    }

    let exec_row = sqlx::query(
        r#"
        INSERT INTO commerce_executions
            (intent_id, quote_id, user_id, status, handoff, privacy_mode, network_scope,
             user_approved_at, approval_nonce, approval_summary)
        VALUES ($1, $2, $3, 'reserved', $4, $5, $6, $7, $8, $9)
        RETURNING id, intent_id, quote_id, status, handoff, created_at
        "#,
    )
    .bind(intent_id)
    .bind(quote.id)
    .bind(user_id)
    .bind(&reserve)
    .bind(&approval.privacy_mode)
    .bind(&approval.network_scope)
    .bind(approval.user_approved_at)
    .bind(&approval.approval_nonce_hash)
    .bind(&approval.approval_summary)
    .fetch_one(&mut *tx)
    .await?;

    let execution_id: Uuid = exec_row.get("id");
    let receipt_payload = json!({
        "kind": "commerce_reservation_receipt",
        "message": "Ghola reserved private balance for this approved commerce execution.",
        "intent_goal_hash": sensitive_text_hash(&intent.goal),
        "adapter": quote.adapter,
        "offer_id": quote.offer_id,
        "provider_slug": quote.provider_slug,
        "policy": quote.policy,
        "approval_summary": req.approval.approval_summary,
        "redacted": true,
    });

    let receipt_row = sqlx::query(
        r#"
        INSERT INTO commerce_receipts
            (execution_id, intent_id, quote_id, user_id, status, adapter,
             amount_micro_usdc, currency, rail, receipt)
        VALUES ($1, $2, $3, $4, 'reserved', $5, $6, $7, $8, $9)
        RETURNING id, execution_id, status, adapter, amount_micro_usdc,
                  currency, rail, receipt, created_at
        "#,
    )
    .bind(execution_id)
    .bind(intent_id)
    .bind(quote.id)
    .bind(user_id)
    .bind(&quote.adapter)
    .bind(quote.amount_micro_usdc)
    .bind(&quote.currency)
    .bind(&quote.rail)
    .bind(&receipt_payload)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query("UPDATE commerce_quotes SET status = 'accepted', updated_at = now() WHERE id = $1")
        .bind(quote.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE commerce_intents SET status = 'approved', updated_at = now() WHERE id = $1",
    )
    .bind(intent_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let execution_id: Uuid = exec_row.get("id");
    let receipt_id: Uuid = receipt_row.get("id");

    let completed = match execute_reserved_agent(state, &intent, &quote, execution_id).await {
        Ok(completed) => completed,
        Err(err) => {
            mark_execution_failed(
                &state.db,
                execution_id,
                intent_id,
                quote.id,
                &err.to_string(),
            )
            .await?;
            return Err(err);
        }
    };

    let mut tx = state.db.begin().await?;
    lock_user_balance(&mut tx, user_id).await?;
    let actual_cost = ((completed.input_tokens as i64 * completed.price_per_1k_input
        + completed.output_tokens as i64 * completed.price_per_1k_output)
        / 1000)
        .max(1000)
        .min(quote.amount_micro_usdc);
    let provider_amount = actual_cost * 85 / 100;
    let platform_fee = actual_cost - provider_amount;
    let payment_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO x402_payments
            (tx_signature, payer_address, amount_usdc, required_amount_usdc,
             agent_id, provider_id, provider_amount, platform_fee, settled,
             model_id, input_tokens, output_tokens, latency_ms, status, settled_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10, $11, $12, 'settled', now())
        RETURNING id
        "#,
    )
    .bind(format!("commerce:{execution_id}"))
    .bind(format!(
        "ghola_balance:{}",
        &sensitive_text_hash(&intent.user_id.to_string())[..12]
    ))
    .bind(actual_cost)
    .bind(quote.amount_micro_usdc)
    .bind(completed.agent_id)
    .bind(completed.provider_id)
    .bind(provider_amount)
    .bind(platform_fee)
    .bind(&completed.model_id)
    .bind(completed.input_tokens as i32)
    .bind(completed.output_tokens as i32)
    .bind(completed.latency_ms as i32)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        UPDATE compute_providers
        SET total_earned_usdc = total_earned_usdc + $1, updated_at = now()
        WHERE id = $2
        "#,
    )
    .bind(provider_amount)
    .bind(completed.provider_id)
    .execute(&mut *tx)
    .await?;

    let completed_receipt = json!({
        "kind": "commerce_execution_receipt",
        "message": "Ghola executed the approved intent using reserved private balance.",
        "intent_goal_hash": sensitive_text_hash(&intent.goal),
        "adapter": quote.adapter,
        "offer_id": quote.offer_id,
        "provider_slug": quote.provider_slug,
        "payment_id": payment_id,
        "amount_micro_usdc": actual_cost,
        "provider_amount_micro_usdc": provider_amount,
        "platform_fee_micro_usdc": platform_fee,
        "result": {
            "input_tokens": completed.input_tokens,
            "output_tokens": completed.output_tokens,
            "latency_ms": completed.latency_ms,
            "text_redacted": true,
        },
        "policy": quote.policy,
        "approval_summary": req.approval.approval_summary,
        "redacted": true,
    });
    let completed_handoff = json!({
        "kind": "ghola_balance_execution",
        "intent_id": intent.id,
        "quote_id": quote.id,
        "adapter": quote.adapter,
        "offer_id": quote.offer_id,
        "provider_slug": quote.provider_slug,
        "amount_micro_usdc": actual_cost,
        "currency": quote.currency,
        "rail": quote.rail,
        "payment_id": payment_id,
        "next_action": "completed",
    });

    let exec_row = sqlx::query(
        r#"
        UPDATE commerce_executions
        SET status = 'completed', handoff = $2, completed_at = now(), updated_at = now()
        WHERE id = $1 AND user_id = $3
        RETURNING id, intent_id, quote_id, status, handoff, created_at
        "#,
    )
    .bind(execution_id)
    .bind(&completed_handoff)
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await?;
    let receipt_row = sqlx::query(
        r#"
        UPDATE commerce_receipts
        SET status = 'completed', receipt = $2, amount_micro_usdc = $4
        WHERE id = $1 AND user_id = $3
        RETURNING id, execution_id, status, adapter, amount_micro_usdc,
                  currency, rail, receipt, created_at
        "#,
    )
    .bind(receipt_id)
    .bind(&completed_receipt)
    .bind(user_id)
    .bind(actual_cost)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE commerce_intents SET status = 'completed', updated_at = now() WHERE id = $1",
    )
    .bind(intent_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let _ = compute_service::update_reputation(
        &state.db,
        completed.provider_id,
        true,
        Some(completed.latency_ms as i64),
    )
    .await;

    Ok(CommerceExecution {
        id: exec_row.get("id"),
        intent_id: exec_row.get("intent_id"),
        quote_id: exec_row.get("quote_id"),
        status: exec_row.get("status"),
        handoff: exec_row.get("handoff"),
        receipt: row_to_receipt(&receipt_row),
        created_at: exec_row.get("created_at"),
    })
}

struct CompletedAgentExecution {
    agent_id: Uuid,
    provider_id: Uuid,
    model_id: String,
    price_per_1k_input: i64,
    price_per_1k_output: i64,
    input_tokens: u32,
    output_tokens: u32,
    latency_ms: u64,
}

async fn execute_reserved_agent(
    state: &AppState,
    intent: &CommerceIntent,
    quote: &CommerceQuote,
    execution_id: Uuid,
) -> Result<CompletedAgentExecution, CloudError> {
    let slug = quote
        .provider_slug
        .as_deref()
        .ok_or_else(|| CloudError::BadRequest("quote is missing provider slug".into()))?;
    let public_agent = agent_service::get_public_agent(&state.db, slug).await?;
    let matched = agent_service::match_agents(
        &state.db,
        &agent_service::AgentMatchCriteria {
            require_tags: vec![],
            require_tools: vec![],
            prefer_model: Some(public_agent.model_id.clone()),
            min_reputation: 0.0,
            limit: 100,
        },
    )
    .await?;
    let matched_agent = matched
        .iter()
        .find(|agent| agent.agent_id == public_agent.id)
        .ok_or_else(|| CloudError::ServiceUnavailable("agent's provider is offline".into()))?;

    let messages = json!([
        {
            "role": "user",
            "content": intent.goal,
        }
    ]);
    let result = compute_service::dispatch_inference(
        state,
        &matched_agent.relay_pubkey,
        &messages,
        Some(&matched_agent.system_prompt),
        &matched_agent.model_id,
        1000,
        &format!("commerce-{execution_id}"),
    )
    .await?;

    let input_tokens = result.input_tokens.max((intent.goal.len() / 4) as u32);
    let output_tokens = result.output_tokens.max((result.text.len() / 4) as u32);
    Ok(CompletedAgentExecution {
        agent_id: public_agent.id,
        provider_id: matched_agent.provider_id,
        model_id: matched_agent.model_id.clone(),
        price_per_1k_input: matched_agent.price_per_1k_input,
        price_per_1k_output: matched_agent.price_per_1k_output,
        input_tokens,
        output_tokens,
        latency_ms: result.latency_ms,
    })
}

async fn mark_execution_failed(
    db: &PgPool,
    execution_id: Uuid,
    intent_id: Uuid,
    quote_id: Uuid,
    error: &str,
) -> Result<(), CloudError> {
    sqlx::query(
        r#"
        UPDATE commerce_executions
        SET status = 'failed', error_message = $2, updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(execution_id)
    .bind(error)
    .execute(db)
    .await?;
    sqlx::query("UPDATE commerce_receipts SET status = 'failed' WHERE execution_id = $1")
        .bind(execution_id)
        .execute(db)
        .await?;
    sqlx::query(
        "UPDATE commerce_quotes SET status = 'cancelled', updated_at = now() WHERE id = $1",
    )
    .bind(quote_id)
    .execute(db)
    .await?;
    sqlx::query("UPDATE commerce_intents SET status = 'failed', updated_at = now() WHERE id = $1")
        .bind(intent_id)
        .execute(db)
        .await?;
    Ok(())
}

async fn lock_user_balance(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<(), CloudError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(user_id.to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn expire_stale_holds(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<(), CloudError> {
    let interval = format!("{HOLD_TTL_MINUTES} minutes");
    sqlx::query(
        r#"
        WITH expired AS (
            SELECT execution_id, intent_id
            FROM commerce_receipts
            WHERE user_id = $1
              AND status = 'reserved'
              AND created_at < now() - $2::interval
        )
        UPDATE commerce_executions
        SET status = 'failed', error_message = 'reservation expired', updated_at = now()
        WHERE id IN (SELECT execution_id FROM expired)
        "#,
    )
    .bind(user_id)
    .bind(&interval)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        r#"
        WITH expired AS (
            SELECT intent_id
            FROM commerce_receipts
            WHERE user_id = $1
              AND status = 'reserved'
              AND created_at < now() - $2::interval
        )
        UPDATE commerce_intents
        SET status = 'failed', updated_at = now()
        WHERE id IN (SELECT intent_id FROM expired)
        "#,
    )
    .bind(user_id)
    .bind(&interval)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        r#"
        UPDATE commerce_receipts
        SET status = 'failed'
        WHERE user_id = $1
          AND status = 'reserved'
          AND created_at < now() - $2::interval
        "#,
    )
    .bind(user_id)
    .bind(&interval)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn rail_options(private_requested: bool) -> Vec<CommerceRailOption> {
    let shielded = x402_service::shielded_stablecoin_runtime_status();
    vec![
        CommerceRailOption {
            rail: x402_service::PaymentRailKind::ShieldedStablecoin
                .canonical_rail()
                .to_string(),
            label: "Private USDCx".to_string(),
            available: shielded.ready,
            privacy_disclosure: shielded.privacy_disclosure.to_string(),
            unavailable_reason: shielded.unavailable_reason.map(str::to_string),
        },
        CommerceRailOption {
            rail: x402_service::PaymentRailKind::SolanaPublicStablecoin
                .canonical_rail()
                .to_string(),
            label: "Public USDC".to_string(),
            available: !private_requested,
            privacy_disclosure: x402_service::PUBLIC_STABLECOIN_DISCLOSURE.to_string(),
            unavailable_reason: if private_requested {
                Some("Private mode does not silently downgrade to public USDC.".to_string())
            } else {
                None
            },
        },
    ]
}

fn default_rail_for_intent(intent: &CommerceIntent) -> Result<(String, String, bool), CloudError> {
    if intent.privacy_mode == "private" {
        let shielded = x402_service::shielded_stablecoin_runtime_status();
        if !shielded.ready {
            return Err(CloudError::PaymentRequired(format!(
                "private settlement unavailable: {}",
                shielded
                    .unavailable_reason
                    .unwrap_or("shielded stablecoin adapter is unavailable")
            )));
        }
        return Ok((
            x402_service::PaymentRailKind::ShieldedStablecoin
                .canonical_rail()
                .to_string(),
            shielded.privacy_disclosure.to_string(),
            true,
        ));
    }

    Ok((
        x402_service::PaymentRailKind::SolanaPublicStablecoin
            .canonical_rail()
            .to_string(),
        x402_service::PUBLIC_STABLECOIN_DISCLOSURE.to_string(),
        true,
    ))
}

fn fixture_catalog_offers(intent: &CommerceIntent) -> Vec<CommerceOffer> {
    let (rail, privacy_disclosure, available) = match default_rail_for_intent(intent) {
        Ok(values) => values,
        Err(err) => (
            x402_service::PaymentRailKind::ShieldedStablecoin
                .canonical_rail()
                .to_string(),
            x402_service::shielded_stablecoin_runtime_status()
                .privacy_disclosure
                .to_string(),
            matches!(err, CloudError::PaymentRequired(_)) && false,
        ),
    };
    let unavailable_reason = if available {
        None
    } else {
        Some("Private USDCx is not ready, and private mode cannot use public fallback.".to_string())
    };

    vec![
        CommerceOffer {
            offer_id: "fixture:private-checkout-demo".to_string(),
            adapter: "fixture_catalog".to_string(),
            title: "Private checkout demo".to_string(),
            description:
                "A curated end-to-end checkout proving Ghola can quote, approve, settle, and receipt a private purchase flow."
                    .to_string(),
            merchant_label: "Ghola Demo Merchant".to_string(),
            merchant_type: "curated_demo".to_string(),
            offer_image_url: None,
            fulfillment_kind: "digital_receipt".to_string(),
            trust_summary: "Curated demo · no raw provider payloads · explicit approval required"
                .to_string(),
            provider_slug: "ghola-demo-merchant".to_string(),
            model_id: "fixture_catalog_v1".to_string(),
            tags: vec!["demo".to_string(), "private".to_string(), "checkout".to_string()],
            tools: vec!["quote".to_string(), "receipt".to_string()],
            provider_reputation: 5.0,
            amount_micro_usdc: 1_000,
            currency: "USDC".to_string(),
            rail,
            rail_options: rail_options(intent.privacy_mode == "private"),
            privacy_disclosure,
            available,
            unavailable_reason,
            raw_offer: json!({
                "redacted": true,
                "source": "fixture_catalog",
            }),
        },
        CommerceOffer {
            offer_id: "fixture:merchant-discovery-demo".to_string(),
            adapter: "fixture_catalog".to_string(),
            title: "Find a verified merchant".to_string(),
            description:
                "Ghola compares merchant options, explains trust/privacy tradeoffs, and prepares a user-approved checkout."
                    .to_string(),
            merchant_label: "Ghola Verified Catalog".to_string(),
            merchant_type: "curated_demo".to_string(),
            offer_image_url: None,
            fulfillment_kind: "merchant_recommendation".to_string(),
            trust_summary: "Local-first discovery · explicit external handoff · receipt export ready"
                .to_string(),
            provider_slug: "ghola-verified-catalog".to_string(),
            model_id: "fixture_catalog_v1".to_string(),
            tags: vec!["merchant".to_string(), "discovery".to_string()],
            tools: vec!["compare".to_string(), "quote".to_string()],
            provider_reputation: 5.0,
            amount_micro_usdc: 2_500,
            currency: "USDC".to_string(),
            rail: x402_service::PaymentRailKind::SolanaPublicStablecoin
                .canonical_rail()
                .to_string(),
            rail_options: rail_options(false),
            privacy_disclosure: x402_service::PUBLIC_STABLECOIN_DISCLOSURE.to_string(),
            available: intent.privacy_mode != "private",
            unavailable_reason: if intent.privacy_mode == "private" {
                Some("This demo offer is public-only and blocked in private mode.".to_string())
            } else {
                None
            },
            raw_offer: json!({
                "redacted": true,
                "source": "fixture_catalog",
            }),
        },
    ]
}

fn merchant_checkout_placeholder(intent: &CommerceIntent) -> CommerceOffer {
    CommerceOffer {
        offer_id: "merchant_checkout:coming-soon".to_string(),
        adapter: "merchant_checkout".to_string(),
        title: "External merchant checkout".to_string(),
        description:
            "Shopify, Stripe Payment Link, and direct merchant checkout adapters will plug in here."
                .to_string(),
        merchant_label: "Merchant checkout adapter".to_string(),
        merchant_type: "external_checkout".to_string(),
        offer_image_url: None,
        fulfillment_kind: "external_checkout".to_string(),
        trust_summary:
            "Planned adapter · blocked until a reviewed merchant integration is configured"
                .to_string(),
        provider_slug: "merchant-checkout".to_string(),
        model_id: "merchant_checkout_v1".to_string(),
        tags: vec!["merchant".to_string(), "checkout".to_string()],
        tools: vec!["quote".to_string(), "checkout".to_string()],
        provider_reputation: 0.0,
        amount_micro_usdc: 1_000,
        currency: "USDC".to_string(),
        rail: if intent.privacy_mode == "private" {
            x402_service::PaymentRailKind::ShieldedStablecoin.canonical_rail()
        } else {
            x402_service::PaymentRailKind::SolanaPublicStablecoin.canonical_rail()
        }
        .to_string(),
        rail_options: rail_options(intent.privacy_mode == "private"),
        privacy_disclosure:
            "External merchant checkout is disabled until a reviewed adapter is configured."
                .to_string(),
        available: false,
        unavailable_reason: Some("Merchant checkout adapter is not configured yet.".to_string()),
        raw_offer: json!({
            "redacted": true,
            "source": "merchant_checkout",
        }),
    }
}

async fn create_fixture_quote(
    state: &AppState,
    user_id: Uuid,
    intent: CommerceIntent,
    req: CreateQuoteRequest,
) -> Result<CommerceQuote, CloudError> {
    let offer = fixture_catalog_offers(&intent)
        .into_iter()
        .find(|offer| offer.offer_id == req.offer_id)
        .ok_or_else(|| CloudError::NotFound("fixture offer not found".into()))?;
    if !offer.available {
        return Err(CloudError::PaymentRequired(
            offer
                .unavailable_reason
                .unwrap_or_else(|| "fixture offer unavailable".to_string()),
        ));
    }
    if offer.amount_micro_usdc > intent.budget_micro_usdc {
        return Err(CloudError::BadRequest(
            "selected offer exceeds intent budget".into(),
        ));
    }

    let quote_id = Uuid::new_v4();
    let expires_at = Utc::now() + Duration::minutes(QUOTE_TTL_MINUTES);
    let policy = json!({
        "intent_id": intent.id,
        "quote_id": quote_id,
        "budget_micro_usdc": intent.budget_micro_usdc,
        "privacy_mode": intent.privacy_mode,
        "adapter": "fixture_catalog",
        "rail": offer.rail,
        "fail_closed": intent.privacy_mode == "private",
        "fallback_allowed": intent.privacy_mode != "private",
        "funded_private_settlement_status": "funded_usdcx_proof_pending",
        "expires_at": expires_at,
    });
    let payment_requirements = json!({
        "redacted": true,
        "kind": "fixture_catalog_quote",
        "requires_user_approval": true,
        "rail": offer.rail,
        "fallback_allowed": intent.privacy_mode != "private",
    });
    let raw_offer = json!({
        "redacted": true,
        "source": "fixture_catalog",
        "offer_id": offer.offer_id,
    });

    let row = sqlx::query(
        r#"
        INSERT INTO commerce_quotes
            (id, intent_id, user_id, adapter, offer_id, provider_slug, provider_label,
             amount_micro_usdc, currency, rail, payment_requirements, policy, raw_offer, expires_at)
        VALUES ($1, $2, $3, 'fixture_catalog', $4, $5, $6, $7, 'USDC', $8, $9, $10, $11, $12)
        RETURNING id, intent_id, adapter, offer_id, provider_slug, provider_label,
                  amount_micro_usdc, currency, rail, status, payment_requirements,
                  policy, raw_offer, expires_at, created_at
        "#,
    )
    .bind(quote_id)
    .bind(intent.id)
    .bind(user_id)
    .bind(&offer.offer_id)
    .bind(&offer.provider_slug)
    .bind(&offer.merchant_label)
    .bind(offer.amount_micro_usdc)
    .bind(&offer.rail)
    .bind(&payment_requirements)
    .bind(&policy)
    .bind(&raw_offer)
    .bind(expires_at)
    .fetch_one(&state.db)
    .await?;

    sqlx::query("UPDATE commerce_intents SET status = 'quoted', updated_at = now() WHERE id = $1")
        .bind(intent.id)
        .execute(&state.db)
        .await?;

    Ok(row_to_quote(&row))
}

async fn execute_fixture_quote(
    state: &AppState,
    user_id: Uuid,
    intent: CommerceIntent,
    quote: CommerceQuote,
    approval: crate::privacy::StoredPrivacyApproval,
    raw_approval: &PrivacyApproval,
) -> Result<CommerceExecution, CloudError> {
    let handoff = json!({
        "kind": "fixture_catalog_execution",
        "intent_id": intent.id,
        "quote_id": quote.id,
        "adapter": quote.adapter,
        "offer_id": quote.offer_id,
        "provider_slug": quote.provider_slug,
        "amount_micro_usdc": quote.amount_micro_usdc,
        "currency": quote.currency,
        "rail": quote.rail,
        "settlement_status": "fixture_no_funds_canary",
        "funded_private_settlement_status": "funded_usdcx_proof_pending",
        "next_action": "receipt",
    });
    let receipt_payload = json!({
        "kind": "commerce_fixture_receipt",
        "message": "Ghola completed a curated private checkout demo without exposing raw provider payloads.",
        "intent_goal_hash": sensitive_text_hash(&intent.goal),
        "adapter": quote.adapter,
        "offer_id": quote.offer_id,
        "provider_slug": quote.provider_slug,
        "amount_micro_usdc": quote.amount_micro_usdc,
        "currency": quote.currency,
        "rail": quote.rail,
        "settlement_status": "fixture_no_funds_canary",
        "funded_private_settlement_status": "funded_usdcx_proof_pending",
        "approval_summary": raw_approval.approval_summary,
        "redacted": true,
    });

    let mut tx = state.db.begin().await?;
    let exec_row = sqlx::query(
        r#"
        INSERT INTO commerce_executions
            (intent_id, quote_id, user_id, status, handoff, privacy_mode, network_scope,
             user_approved_at, approval_nonce, approval_summary, completed_at)
        VALUES ($1, $2, $3, 'completed', $4, $5, $6, $7, $8, $9, now())
        RETURNING id, intent_id, quote_id, status, handoff, created_at
        "#,
    )
    .bind(intent.id)
    .bind(quote.id)
    .bind(user_id)
    .bind(&handoff)
    .bind(&approval.privacy_mode)
    .bind(&approval.network_scope)
    .bind(approval.user_approved_at)
    .bind(&approval.approval_nonce_hash)
    .bind(&approval.approval_summary)
    .fetch_one(&mut *tx)
    .await?;
    let execution_id: Uuid = exec_row.get("id");
    let receipt_row = sqlx::query(
        r#"
        INSERT INTO commerce_receipts
            (execution_id, intent_id, quote_id, user_id, status, adapter,
             amount_micro_usdc, currency, rail, receipt)
        VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7, $8, $9)
        RETURNING id, execution_id, status, adapter, amount_micro_usdc,
                  currency, rail, receipt, created_at
        "#,
    )
    .bind(execution_id)
    .bind(intent.id)
    .bind(quote.id)
    .bind(user_id)
    .bind(&quote.adapter)
    .bind(quote.amount_micro_usdc)
    .bind(&quote.currency)
    .bind(&quote.rail)
    .bind(&receipt_payload)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("UPDATE commerce_quotes SET status = 'accepted', updated_at = now() WHERE id = $1")
        .bind(quote.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE commerce_intents SET status = 'completed', updated_at = now() WHERE id = $1",
    )
    .bind(intent.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    record_privacy_audit_event(
        &state.db,
        user_id,
        NetworkScope::CommerceExecution,
        &approval,
        "commerce_fixture_execution",
    )
    .await;

    Ok(CommerceExecution {
        id: exec_row.get("id"),
        intent_id: exec_row.get("intent_id"),
        quote_id: exec_row.get("quote_id"),
        status: exec_row.get("status"),
        handoff: exec_row.get("handoff"),
        receipt: row_to_receipt(&receipt_row),
        created_at: exec_row.get("created_at"),
    })
}

pub async fn get_execution(
    db: &PgPool,
    user_id: Uuid,
    execution_id: Uuid,
) -> Result<CommerceExecution, CloudError> {
    let exec_row = sqlx::query(
        r#"
        SELECT id, intent_id, quote_id, status, handoff, created_at
        FROM commerce_executions
        WHERE id = $1 AND user_id = $2
        "#,
    )
    .bind(execution_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| CloudError::NotFound("commerce execution not found".into()))?;
    let receipt_row = sqlx::query(
        r#"
        SELECT id, execution_id, status, adapter, amount_micro_usdc,
               currency, rail, receipt, created_at
        FROM commerce_receipts
        WHERE execution_id = $1 AND user_id = $2
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(execution_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| CloudError::NotFound("commerce receipt not found".into()))?;

    Ok(CommerceExecution {
        id: exec_row.get("id"),
        intent_id: exec_row.get("intent_id"),
        quote_id: exec_row.get("quote_id"),
        status: exec_row.get("status"),
        handoff: exec_row.get("handoff"),
        receipt: row_to_receipt(&receipt_row),
        created_at: exec_row.get("created_at"),
    })
}

pub async fn get_receipt(
    db: &PgPool,
    user_id: Uuid,
    receipt_id: Uuid,
) -> Result<CommerceReceipt, CloudError> {
    let row = sqlx::query(
        r#"
        SELECT id, execution_id, status, adapter, amount_micro_usdc,
               currency, rail, receipt, created_at
        FROM commerce_receipts
        WHERE id = $1 AND user_id = $2
        "#,
    )
    .bind(receipt_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| CloudError::NotFound("commerce receipt not found".into()))?;
    Ok(row_to_receipt(&row))
}

pub async fn export_receipt(
    state: &AppState,
    user_id: Uuid,
    receipt_id: Uuid,
    req: ExportCommerceReceiptRequest,
) -> Result<CommerceReceiptExport, CloudError> {
    let approval = req
        .approval
        .require_and_store_for(NetworkScope::CommerceExecution)?;
    let receipt = get_receipt(&state.db, user_id, receipt_id).await?;
    record_privacy_audit_event(
        &state.db,
        user_id,
        NetworkScope::CommerceExecution,
        &approval,
        "commerce_receipt_export",
    )
    .await;
    Ok(CommerceReceiptExport {
        receipt,
        exported_at: Utc::now(),
        audience: req.audience.unwrap_or_else(|| "user".to_string()),
        reason: req.reason,
    })
}

fn normalize_adapters(adapters: Option<Vec<String>>) -> Vec<String> {
    let mut out = adapters.unwrap_or_else(|| {
        vec![
            "fixture_catalog".to_string(),
            "x402_agent".to_string(),
            "merchant_checkout".to_string(),
        ]
    });
    for adapter in &mut out {
        if adapter == "x402" {
            *adapter = "x402_agent".to_string();
        }
    }
    out.retain(|adapter| {
        adapter == "fixture_catalog"
            || adapter == "x402_agent"
            || adapter == "merchant_checkout"
            || adapter == "mcp"
    });
    if out.is_empty() {
        out.push("fixture_catalog".to_string());
    }
    out.sort();
    out.dedup();
    out
}

fn retain_payment_rail(payment_requirements: &mut Value, rail: &str) {
    let Some(accepts) = payment_requirements
        .get_mut("accepts")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    accepts.retain(|option| {
        option
            .get("extra")
            .and_then(|extra| extra.get("payment_rail"))
            .and_then(Value::as_str)
            == Some(rail)
    });
}

fn is_private_rail(rail: &str) -> bool {
    matches!(
        rail,
        x402_service::SHIELDED_STABLECOIN_RAIL | x402_service::ALEO_USDCX_SHIELDED_RAIL
    )
}

async fn get_quote(
    db: &PgPool,
    user_id: Uuid,
    intent_id: Uuid,
    quote_id: Uuid,
) -> Result<CommerceQuote, CloudError> {
    let row = sqlx::query(
        r#"
        SELECT id, intent_id, adapter, offer_id, provider_slug, provider_label,
               amount_micro_usdc, currency, rail, status, payment_requirements,
               policy, raw_offer, expires_at, created_at
        FROM commerce_quotes
        WHERE id = $1 AND intent_id = $2 AND user_id = $3 AND status = 'quoted'
        "#,
    )
    .bind(quote_id)
    .bind(intent_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| CloudError::NotFound("commerce quote not found".into()))?;

    Ok(row_to_quote(&row))
}

async fn available_private_balance(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<i64, CloudError> {
    let funded = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COALESCE(SUM(amount_usdc), 0)
        FROM private_balance_deposits
        WHERE user_id = $1 AND status IN ('paid', 'shield_pending', 'shielded')
        "#,
    )
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await?;
    let reserved = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COALESCE(SUM(amount_micro_usdc), 0)
        FROM commerce_receipts
        WHERE user_id = $1 AND status IN ('reserved', 'completed')
        "#,
    )
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok((funded - reserved).max(0))
}

fn row_to_intent(row: &sqlx::postgres::PgRow) -> CommerceIntent {
    CommerceIntent {
        id: row.get("id"),
        user_id: row.get("user_id"),
        goal: row.get("goal"),
        budget_micro_usdc: row.get("budget_micro_usdc"),
        privacy_mode: row.get("privacy_mode"),
        preferred_rail: row.get("preferred_rail"),
        allowed_adapters: row.get("allowed_adapters"),
        deadline_at: row.get("deadline_at"),
        status: row.get("status"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn row_to_quote(row: &sqlx::postgres::PgRow) -> CommerceQuote {
    CommerceQuote {
        id: row.get("id"),
        intent_id: row.get("intent_id"),
        adapter: row.get("adapter"),
        offer_id: row.get("offer_id"),
        provider_slug: row.get("provider_slug"),
        provider_label: row.get("provider_label"),
        amount_micro_usdc: row.get("amount_micro_usdc"),
        currency: row.get("currency"),
        rail: row.get("rail"),
        status: row.get("status"),
        payment_requirements: row.get("payment_requirements"),
        policy: row.get("policy"),
        raw_offer: row.get("raw_offer"),
        expires_at: row.get("expires_at"),
        created_at: row.get("created_at"),
    }
}

fn row_to_receipt(row: &sqlx::postgres::PgRow) -> CommerceReceipt {
    CommerceReceipt {
        id: row.get("id"),
        execution_id: row.get("execution_id"),
        status: row.get("status"),
        adapter: row.get("adapter"),
        amount_micro_usdc: row.get("amount_micro_usdc"),
        currency: row.get("currency"),
        rail: row.get("rail"),
        receipt: row.get("receipt"),
        created_at: row.get("created_at"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CloudConfig;
    use std::sync::{Mutex, OnceLock};

    static COMMERCE_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    struct EnvRestore {
        previous: Vec<(&'static str, Option<String>)>,
    }

    impl EnvRestore {
        fn set(overrides: &[(&'static str, String)]) -> Self {
            let previous = overrides
                .iter()
                .map(|(key, _)| (*key, std::env::var(key).ok()))
                .collect::<Vec<_>>();
            for (key, value) in overrides {
                std::env::set_var(key, value);
            }
            Self { previous }
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            for (key, value) in self.previous.drain(..) {
                if let Some(value) = value {
                    std::env::set_var(key, value);
                } else {
                    std::env::remove_var(key);
                }
            }
        }
    }

    fn test_intent(privacy_mode: &str) -> CommerceIntent {
        let now = Utc::now();
        CommerceIntent {
            id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            goal: "Find a private checkout option".to_string(),
            budget_micro_usdc: 5_000_000,
            privacy_mode: privacy_mode.to_string(),
            preferred_rail: if privacy_mode == "private" {
                "aleo_usdcx_shielded".to_string()
            } else {
                "solana_public_usdc".to_string()
            },
            allowed_adapters: vec![],
            deadline_at: None,
            status: "created".to_string(),
            created_at: now,
            updated_at: now,
        }
    }

    fn test_config(database_url: String) -> CloudConfig {
        CloudConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            database_url,
            jwt_secret: "test-jwt-secret".into(),
            bland_api_key: None,
            bland_webhook_url: None,
            claude_api_key: None,
            google_client_id: None,
            google_client_secret: None,
            apple_client_id: None,
            gmail_client_id: None,
            gmail_client_secret: None,
            stripe_secret_key: None,
            stripe_webhook_secret: None,
            stripe_price_pro: None,
            stripe_price_private_agent: None,
            stripe_price_unlimited: None,
            base_url: "http://localhost".into(),
            encryption_key: [0u8; 32],
            telegram_bot_token: None,
            solana_rpc_url: "http://localhost".into(),
            groq_api_key: None,
            cerebras_api_key: None,
            google_gemini_api_key: None,
            openrouter_api_key: None,
            relay_url: "http://localhost".into(),
            platform_wallet_address: None,
            treasury_mnemonic: None,
            min_provider_reputation: 0.0,
            max_escrow_age_secs: 300,
            provider_payout_interval_secs: 3600,
        }
    }

    fn commerce_approval(summary: &str) -> PrivacyApproval {
        PrivacyApproval {
            privacy_mode: Some(crate::privacy::STRICT_LOCAL.to_string()),
            network_scope: Some(NetworkScope::CommerceExecution.as_str().to_string()),
            user_approved_at: Some(Utc::now()),
            approval_nonce: Some(format!("commerce-e2e-{}", Uuid::new_v4())),
            approval_summary: Some(summary.to_string()),
        }
    }

    #[test]
    fn default_commerce_adapters_include_consumer_catalog() {
        let adapters = normalize_adapters(None);
        assert!(adapters.contains(&"fixture_catalog".to_string()));
        assert!(adapters.contains(&"x402_agent".to_string()));
        assert!(adapters.contains(&"merchant_checkout".to_string()));
    }

    #[test]
    fn legacy_x402_adapter_alias_normalizes_to_x402_agent() {
        let adapters = normalize_adapters(Some(vec!["x402".to_string(), "bad".to_string()]));
        assert_eq!(adapters, vec!["x402_agent".to_string()]);
    }

    #[test]
    fn fixture_catalog_offers_are_redacted_for_list_responses() {
        let offers = fixture_catalog_offers(&test_intent("open"));
        assert!(!offers.is_empty());
        for offer in offers {
            assert_eq!(
                offer.raw_offer.get("redacted").and_then(Value::as_bool),
                Some(true)
            );
            assert!(offer.raw_offer.get("provider_payload").is_none());
            assert!(offer.raw_offer.get("wallet_address").is_none());
        }
    }

    #[tokio::test]
    async fn commerce_fixture_flow_completes_with_redacted_receipt_when_e2e_db_configured() {
        let Ok(database_url) = ghola_assistant_types::env_compat("GHOLA_COMMERCE_E2E_DATABASE_URL", "THUMPER_COMMERCE_E2E_DATABASE_URL") else {
            eprintln!("skipping commerce e2e: GHOLA_COMMERCE_E2E_DATABASE_URL is not set");
            return;
        };

        let _lock = COMMERCE_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("commerce env lock poisoned");
        let _env = EnvRestore::set(&[
            (
                "SHIELDED_STABLECOIN_ADAPTER_URL",
                "http://localhost:9/aleo-usdcx-fixture".to_string(),
            ),
            ("SHIELDED_STABLECOIN_PROVIDER", "aleo".to_string()),
            ("SHIELDED_STABLECOIN_NETWORK", "aleo:mainnet".to_string()),
            ("SHIELDED_STABLECOIN_ASSET", "USDCx".to_string()),
            ("SHIELDED_STABLECOIN_RECIPIENT", "aleo1fixture".to_string()),
            (
                "SHIELDED_STABLECOIN_ADAPTER_AUTH_TOKEN",
                "test-adapter-token".to_string(),
            ),
            (
                "SHIELDED_STABLECOIN_REQUIRE_SIGNED_RECEIPT",
                "false".to_string(),
            ),
            ("SHIELDED_STABLECOIN_VERIFIER_READY", "true".to_string()),
        ]);

        let pool = crate::db::create_pool(&database_url)
            .await
            .expect("connect commerce e2e database");
        crate::db::run_migrations(&pool)
            .await
            .expect("run commerce e2e migrations");
        let state = AppState::new(test_config(database_url), pool.clone());
        let email = format!("commerce-e2e-{}@example.test", Uuid::new_v4());
        let user_id: Uuid = sqlx::query_scalar(
            "INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id",
        )
        .bind(email)
        .bind("Commerce E2E")
        .fetch_one(&pool)
        .await
        .expect("insert commerce e2e user");

        let intent = create_intent(
            &pool,
            user_id,
            CreateIntentRequest {
                goal: "Buy a private AI service without leaking raw checkout details".to_string(),
                budget_micro_usdc: Some(10_000),
                privacy_mode: Some("private".to_string()),
                preferred_rail: Some("aleo_usdcx_shielded".to_string()),
                allowed_adapters: Some(vec!["fixture_catalog".to_string()]),
                deadline_at: None,
            },
        )
        .await
        .expect("create commerce intent");

        let offers = list_offers(&state, user_id, intent.id)
            .await
            .expect("list fixture offers");
        let offer = offers
            .iter()
            .find(|offer| offer.offer_id == "fixture:private-checkout-demo")
            .expect("private fixture offer exists");
        assert!(offer.available);
        assert_eq!(
            offer.rail,
            x402_service::PaymentRailKind::ShieldedStablecoin.canonical_rail()
        );
        assert_eq!(
            offer.raw_offer.get("redacted").and_then(Value::as_bool),
            Some(true)
        );

        let quote = create_quote(
            &state,
            user_id,
            intent.id,
            CreateQuoteRequest {
                offer_id: offer.offer_id.clone(),
                rail: Some(offer.rail.clone()),
            },
        )
        .await
        .expect("create fixture quote");
        assert_eq!(quote.adapter, "fixture_catalog");
        assert_eq!(
            quote.rail,
            x402_service::PaymentRailKind::ShieldedStablecoin.canonical_rail()
        );

        let execution = execute_quote(
            &state,
            user_id,
            intent.id,
            ExecuteQuoteRequest {
                quote_id: quote.id,
                approval: commerce_approval("Approve private fixture commerce execution."),
            },
        )
        .await
        .expect("execute fixture quote");
        assert_eq!(execution.status, "completed");
        assert_eq!(execution.receipt.status, "completed");

        let fetched = get_receipt(&pool, user_id, execution.receipt.id)
            .await
            .expect("fetch receipt");
        let receipt_json = serde_json::to_string(&fetched.receipt).expect("serialize receipt");
        assert!(receipt_json.contains("intent_goal_hash"));
        assert!(receipt_json.contains("funded_usdcx_proof_pending"));
        assert!(!receipt_json.contains("Buy a private AI service"));
        assert!(!receipt_json.contains("approval_nonce"));
        assert!(!receipt_json.contains("wallet_address"));
        assert!(!receipt_json.contains("provider_payload"));

        let export = export_receipt(
            &state,
            user_id,
            execution.receipt.id,
            ExportCommerceReceiptRequest {
                reason: Some("user export".to_string()),
                audience: Some("user".to_string()),
                approval: commerce_approval("Approve commerce receipt export."),
            },
        )
        .await
        .expect("export commerce receipt");
        assert_eq!(export.receipt.id, execution.receipt.id);
        assert_eq!(export.audience, "user");
    }
}
