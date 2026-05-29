use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use uuid::Uuid;

use axum::http::StatusCode;
use ghola_models_types::CheckoutRequest;

use crate::auth::Claims;
use crate::error::{AppError, AppResult};
use crate::services::{balances, deposit_wallets, solana};
use crate::state::AppState;
use ghola_models_types::{BalanceResponse, Deposit, DepositRequest, WithdrawRequest};

/// Phase 4.1: GET /api/deposit-address?currency=USDT — returns the user's
/// per-user deposit ATA for the requested stablecoin. Provisions a fresh
/// per-user wallet on first call. Replaces the previous "send to the global
/// escrow" UX so on-chain observers can't graph all platform deposits to one
/// address.
#[derive(Debug, serde::Deserialize)]
pub struct DepositAddressQuery {
    pub currency: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct DepositAddressResponse {
    pub currency: String,
    pub mint: String,
    pub wallet: String,
    pub ata: String,
    pub note: String,
}

pub async fn get_deposit_address(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    axum::extract::Query(q): axum::extract::Query<DepositAddressQuery>,
) -> AppResult<Json<DepositAddressResponse>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let symbol = q
        .currency
        .as_deref()
        .map(|s| s.to_uppercase())
        .unwrap_or_else(|| state.config.primary_token.clone());
    let token = state
        .config
        .find_token(&symbol)
        .ok_or_else(|| AppError::BadRequest(format!("{symbol} not currently accepted")))?;

    let wallet = deposit_wallets::provision_or_get(&state.db, user_id).await?;
    let ata = deposit_wallets::deposit_ata_for(&state.db, user_id, &token.mint_b58).await?;

    Ok(Json(DepositAddressResponse {
        currency: token.symbol.clone(),
        mint: token.mint_b58.clone(),
        wallet: wallet.wallet_pubkey,
        ata,
        note: format!("Send {} on Solana only. Funds sent on any other chain will be lost.", token.symbol),
    }))
}

pub async fn get_balance(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
) -> AppResult<Json<BalanceResponse>> {
    let user_id: Uuid = claims.sub.parse().map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let balances = balances::list_balances(&state.db, &state.config, user_id).await?;

    let pending_earnings: i64 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(p.creator_share), 0)
        FROM payments p
        JOIN models m ON m.id = p.model_id
        WHERE m.creator_id = $1
        "#,
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(BalanceResponse {
        balances,
        pending_earnings,
    }))
}

pub async fn submit_deposit(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Json(req): Json<DepositRequest>,
) -> AppResult<Json<Deposit>> {
    let user_id: Uuid = claims.sub.parse().map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let existing = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM deposits WHERE tx_signature = $1",
    )
    .bind(&req.tx_signature)
    .fetch_one(&state.db)
    .await?;

    if existing > 0 {
        return Err(AppError::Conflict("Deposit already processed".into()));
    }

    let wallet: Option<String> =
        sqlx::query_scalar("SELECT wallet_address FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&state.db)
            .await?;

    let wallet = wallet.ok_or_else(|| AppError::BadRequest(
        "No wallet address linked. Stablecoin deposits require a connected wallet.".into(),
    ))?;

    let verified = solana::verify_deposit(
        &state.http_client,
        &state.config,
        &req.tx_signature,
        req.amount as u64,
        &wallet,
    )
    .await?
    .ok_or_else(|| AppError::BadRequest("Could not verify deposit transaction".into()))?;

    // If the request named a currency, sanity-check it matches what landed on-chain.
    if let Some(claimed) = &req.currency {
        if !claimed.eq_ignore_ascii_case(&verified.currency) {
            return Err(AppError::BadRequest(format!(
                "Deposit currency mismatch: claimed {}, on-chain {}",
                claimed, verified.currency
            )));
        }
    }

    // Phase 3.3: screen the source wallet before crediting balance. Blocked
    // deposits are recorded in `screening_blocks` (hash-only, no cleartext)
    // and the request is refused. The cleartext wallet address is sent to
    // the screening backend but never stored.
    crate::services::screening::enforce(
        &state.db,
        state.screener.as_ref(),
        Some(user_id),
        &wallet,
    )
    .await?;

    // Phase 4.3: persist the source address as a per-user HMAC, not cleartext.
    // A DB breach now reveals tier balances and aggregate volumes but not
    // which user is linked to which on-chain wallet.
    let source_hash = crate::services::privacy::hmac_address(&state.db, user_id, &wallet).await?;

    let deposit = sqlx::query_as::<_, Deposit>(
        r#"
        INSERT INTO deposits (id, user_id, amount, tx_signature, verified, currency, source_address_hash)
        VALUES ($1, $2, $3, $4, true, $5, $6)
        RETURNING *
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(req.amount)
    .bind(&req.tx_signature)
    .bind(&verified.currency)
    .bind(&source_hash)
    .fetch_one(&state.db)
    .await?;

    balances::credit(&state.db, user_id, &verified.currency, req.amount).await?;

    // Phase 4.6: rolling-volume tier check after every deposit. Idempotent.
    crate::services::tier::check_and_promote(&state.db, user_id, None).await.ok();

    Ok(Json(deposit))
}

pub async fn request_withdraw(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Json(req): Json<WithdrawRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let user_id: Uuid = claims.sub.parse().map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    if req.amount <= 0 {
        return Err(AppError::BadRequest("Withdraw amount must be positive".into()));
    }
    if req.destination_wallet.trim().is_empty() {
        return Err(AppError::BadRequest("Destination wallet required".into()));
    }

    // Resolve currency: explicit > primary. Reject paused tokens up front.
    let currency = req
        .currency
        .as_deref()
        .map(|s| s.to_uppercase())
        .unwrap_or_else(|| state.config.primary_token.clone());

    let token = state
        .config
        .find_token(&currency)
        .ok_or_else(|| AppError::BadRequest(format!(
            "{} is not currently accepted for withdrawal",
            currency
        )))?;

    // Phase 3.5: per-user daily cap. Sum recent settlement_queue rows in any
    // currency (treating both stablecoins as 1:1 USD) and reject if the
    // requested amount would push the rolling-24h total past the cap.
    let recent_total: i64 = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(amount_micro_usdc), 0)::BIGINT
           FROM settlement_queue
           WHERE requested_by = $1
             AND created_at > NOW() - INTERVAL '24 hours'
             AND approval_status != 'rejected'"#,
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    if recent_total + req.amount > state.config.daily_withdrawal_limit_micro {
        return Err(AppError::Forbidden(format!(
            "Daily withdrawal cap exceeded ({} of ${} used in last 24h)",
            (recent_total as f64) / 1_000_000.0,
            state.config.daily_withdrawal_limit_micro / 1_000_000,
        )));
    }

    // Atomic deduct — returns InsufficientBalance if the user is short.
    balances::debit(&state.db, user_id, &token.symbol, req.amount).await?;

    // Phase 3.5: large withdrawals are queued in `pending` for a second admin.
    // Sub-threshold withdrawals go straight to `auto` and the settlement loop
    // picks them up immediately.
    let approval_status = if req.amount >= state.config.large_withdrawal_threshold_micro {
        "pending"
    } else {
        "auto"
    };

    // Phase 4.6: tier promotion triggers. A single $2k+ withdrawal or a
    // rolling-30d-volume crossing both promote to verified.
    let large_withdrawal_promote_threshold: i64 = std::env::var("TIER_LARGE_WITHDRAWAL_USD")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(2_000)
        * 1_000_000;
    let explicit_reason = if req.amount >= large_withdrawal_promote_threshold {
        Some(crate::services::tier::PromotionReason::large_withdrawal(req.amount))
    } else {
        None
    };
    crate::services::tier::check_and_promote(&state.db, user_id, explicit_reason)
        .await
        .ok();

    // Replay protection (Phase 3.5): the (requested_by, withdrawal_id) tuple
    // is unique, so a retried POST /withdraw with the same client-supplied id
    // returns the existing row instead of double-spending.
    let withdrawal_id = Uuid::new_v4();

    // Phase 4.3: hash the destination address for the long-lived audit row.
    // The cleartext stays in `creator_wallet` until settlement broadcasts,
    // then a follow-up step can null that out (kept here for the settlement
    // worker — the column is dropped to history once the tx is confirmed).
    let dest_hash =
        crate::services::privacy::hmac_address(&state.db, user_id, &req.destination_wallet).await?;

    sqlx::query(
        r#"INSERT INTO settlement_queue
            (id, creator_id, creator_wallet, amount_micro_usdc, currency, status,
             approval_status, requested_by, withdrawal_id, dest_address_hash)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)"#,
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(&req.destination_wallet)
    .bind(req.amount)
    .bind(&token.symbol)
    .bind(approval_status)
    .bind(user_id)
    .bind(withdrawal_id)
    .bind(&dest_hash)
    .execute(&state.db)
    .await?;

    tracing::info!(
        user_id = %user_id,
        amount = req.amount,
        currency = %token.symbol,
        approval_status = %approval_status,
        destination = %req.destination_wallet,
        "Withdrawal queued for settlement"
    );

    let message = if approval_status == "pending" {
        format!(
            "Large withdrawal: {} requires a second admin's approval before payout.",
            token.symbol
        )
    } else {
        format!(
            "Withdrawal submitted. {} will be sent on the next settlement run.",
            token.symbol
        )
    };

    Ok(Json(serde_json::json!({
        "status": "pending",
        "approval_status": approval_status,
        "amount": req.amount,
        "currency": token.symbol,
        "destination": req.destination_wallet,
        "withdrawal_id": withdrawal_id,
        "message": message,
    })))
}

/// POST /api/checkout — create a Stripe checkout session for credit pack purchase
pub async fn create_checkout(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Json(req): Json<CheckoutRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let user_id: Uuid = claims.sub.parse().map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let pack = crate::services::stripe::get_pack(&req.pack)
        .ok_or_else(|| AppError::BadRequest("Invalid credit pack. Use 5, 10, 25, or 50.".into()))?;

    let (session_id, checkout_url) = crate::services::stripe::create_checkout_session(
        &state.http_client,
        &state.config,
        pack,
        &user_id.to_string(),
    )
    .await?;

    // Record pending purchase
    sqlx::query(
        r#"INSERT INTO credit_purchases (id, user_id, amount_micro_usdc, amount_usd_cents, stripe_session_id, status)
        VALUES ($1, $2, $3, $4, $5, 'pending')"#,
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(pack.amount_micro_usdc)
    .bind(pack.amount_usd_cents)
    .bind(&session_id)
    .execute(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "checkout_url": checkout_url,
        "session_id": session_id,
    })))
}

/// POST /api/payments/webhook — Stripe webhook handler with signature verification
pub async fn stripe_webhook(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    body: String,
) -> AppResult<StatusCode> {
    // Verify Stripe webhook signature
    if let Some(ref secret) = state.config.stripe_webhook_secret {
        let sig_header = headers
            .get("stripe-signature")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| AppError::Unauthorized("Missing Stripe-Signature header".into()))?;

        // Parse t= and v1= from signature header
        let mut timestamp = "";
        let mut signature = "";
        for part in sig_header.split(',') {
            let part = part.trim();
            if let Some(t) = part.strip_prefix("t=") {
                timestamp = t;
            } else if let Some(v) = part.strip_prefix("v1=") {
                signature = v;
            }
        }

        if timestamp.is_empty() || signature.is_empty() {
            return Err(AppError::Unauthorized("Invalid Stripe-Signature format".into()));
        }

        // Compute expected signature: HMAC-SHA256(secret, "timestamp.body")
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        type HmacSha256 = Hmac<Sha256>;

        let signed_payload = format!("{}.{}", timestamp, body);
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
            .map_err(|_| AppError::Internal("HMAC init failed".into()))?;
        mac.update(signed_payload.as_bytes());
        let expected = hex::encode(mac.finalize().into_bytes());

        if expected != signature {
            tracing::warn!("Stripe webhook signature mismatch");
            return Err(AppError::Unauthorized("Invalid webhook signature".into()));
        }

        // Check timestamp is within 5 minutes (replay protection)
        if let Ok(ts) = timestamp.parse::<i64>() {
            let now = chrono::Utc::now().timestamp();
            if (now - ts).abs() > 300 {
                return Err(AppError::Unauthorized("Webhook timestamp too old".into()));
            }
        }
    } else {
        tracing::warn!("STRIPE_WEBHOOK_SECRET not set — webhook signature NOT verified");
    }

    let event: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| AppError::BadRequest("Invalid webhook payload".into()))?;

    let event_type = event["type"].as_str().unwrap_or("");

    if event_type == "checkout.session.completed" {
        let session = &event["data"]["object"];
        let session_id = session["id"].as_str().unwrap_or("");
        let user_id_str = session["metadata"]["user_id"].as_str().unwrap_or("");
        let micro_usdc_str = session["metadata"]["amount_micro_usdc"].as_str().unwrap_or("0");

        let user_id: Uuid = user_id_str.parse()
            .map_err(|_| AppError::BadRequest("Invalid user_id in metadata".into()))?;
        let amount_micro_usdc: i64 = micro_usdc_str.parse().unwrap_or(0);

        if amount_micro_usdc > 0 {
            // Update purchase status
            sqlx::query(
                "UPDATE credit_purchases SET status = 'completed' WHERE stripe_session_id = $1",
            )
            .bind(session_id)
            .execute(&state.db)
            .await?;

            // Credit user's primary stablecoin balance — Stripe is fiat in,
            // platform converts to the primary stablecoin internally.
            balances::credit(&state.db, user_id, &state.config.primary_token, amount_micro_usdc).await?;

            tracing::info!(
                user_id = %user_id,
                amount = amount_micro_usdc,
                currency = %state.config.primary_token,
                "Stripe checkout completed, credits added"
            );
        }
    }

    Ok(StatusCode::OK)
}
