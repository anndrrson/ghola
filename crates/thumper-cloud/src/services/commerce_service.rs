//! Additive agentic-commerce intent orchestration.
//! This owns the front user flow while delegating supply, pricing, and payment
//! details to existing x402/MCP rails.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

use crate::error::CloudError;
use crate::privacy::{NetworkScope, PrivacyApproval};
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
    pub provider_slug: String,
    pub model_id: String,
    pub tags: Vec<String>,
    pub tools: Vec<String>,
    pub provider_reputation: f64,
    pub amount_micro_usdc: i64,
    pub currency: String,
    pub rail: String,
    pub privacy_disclosure: String,
    pub available: bool,
    pub unavailable_reason: Option<String>,
    pub raw_offer: Value,
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

    let preferred_rail = req
        .preferred_rail
        .unwrap_or_else(|| "ghola_balance".to_string());
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

    if intent.allowed_adapters.iter().any(|a| a == "x402") {
        let pricing =
            x402_service::list_agent_pricing(&state.db, state, None, Some("rating")).await?;
        let shielded = x402_service::shielded_stablecoin_runtime_status();
        let private_requested = intent.privacy_mode == "private";
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
                adapter: "x402".to_string(),
                title: agent.display_name.clone(),
                description: agent.description.clone(),
                provider_slug: agent.slug.clone(),
                model_id: agent.model_id.clone(),
                tags: agent.tags.clone(),
                tools: agent.tools.clone(),
                provider_reputation: agent.provider_reputation,
                amount_micro_usdc: amount,
                currency: "USDC".to_string(),
                rail,
                privacy_disclosure,
                available,
                unavailable_reason: if available { None } else { unavailable_reason },
                raw_offer: json!({ "x402_agent": agent }),
            });
        }
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
    let slug = req
        .offer_id
        .strip_prefix("x402:")
        .ok_or_else(|| CloudError::BadRequest("only x402 offers are supported in v1".into()))?;

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
    let rail = rail_kind.as_str().to_string();
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
        "expires_at": expires_at,
    });
    let raw_offer = json!({ "x402_agent": pricing });

    let row = sqlx::query(
        r#"
        INSERT INTO commerce_quotes
            (id, intent_id, user_id, adapter, offer_id, provider_slug, provider_label,
             amount_micro_usdc, currency, rail, payment_requirements, policy, raw_offer, expires_at)
        VALUES ($1, $2, $3, 'x402', $4, $5, $6, $7, 'USDC', $8, $9, $10, $11, $12)
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
        if !shielded.ready
            || quote.rail != x402_service::PaymentRailKind::ShieldedStablecoin.as_str()
        {
            return Err(CloudError::PaymentRequired(
                "private settlement is unavailable; execution failed closed".into(),
            ));
        }
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
        "payment_requirements": quote.payment_requirements,
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
        "intent_goal": intent.goal,
        "adapter": quote.adapter,
        "offer_id": quote.offer_id,
        "provider_slug": quote.provider_slug,
        "policy": quote.policy,
        "approval_summary": req.approval.approval_summary,
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
    .bind(format!("ghola_balance:{}", intent.user_id))
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
        "intent_goal": intent.goal,
        "adapter": quote.adapter,
        "offer_id": quote.offer_id,
        "provider_slug": quote.provider_slug,
        "payment_id": payment_id,
        "amount_micro_usdc": actual_cost,
        "provider_amount_micro_usdc": provider_amount,
        "platform_fee_micro_usdc": platform_fee,
        "result": {
            "text": completed.text,
            "input_tokens": completed.input_tokens,
            "output_tokens": completed.output_tokens,
            "latency_ms": completed.latency_ms,
        },
        "policy": quote.policy,
        "approval_summary": req.approval.approval_summary,
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
    text: String,
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
        text: result.text,
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

fn normalize_adapters(adapters: Option<Vec<String>>) -> Vec<String> {
    let mut out = adapters.unwrap_or_else(|| vec!["x402".to_string(), "mcp".to_string()]);
    out.retain(|adapter| adapter == "x402" || adapter == "mcp");
    if out.is_empty() {
        out.push("x402".to_string());
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
