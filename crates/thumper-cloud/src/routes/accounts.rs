use axum::extract::{Query, State};
use axum::response::Redirect;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::state::AppState;

fn url_encode(s: &str) -> String {
    let mut result = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(b as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", b));
            }
        }
    }
    result
}

#[derive(Serialize)]
pub struct AuthorizeUrlResponse {
    pub authorize_url: String,
}

/// GET /api/accounts/authorize/gmail — Returns Google OAuth consent URL
pub async fn authorize_gmail(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<AuthorizeUrlResponse>, CloudError> {
    let client_id =
        state
            .config
            .gmail_client_id
            .as_deref()
            .ok_or(CloudError::ServiceUnavailable(
                "Gmail OAuth not configured".to_string(),
            ))?;

    // Encode user_id as a short-lived JWT in the state param (10 min expiry)
    let now = chrono::Utc::now();
    let state_claims = crate::auth::Claims {
        sub: claims.sub,
        email: claims.email,
        name: claims.name,
        tier: claims.tier,
        exp: (now + chrono::Duration::minutes(10)).timestamp(),
        iat: now.timestamp(),
    };
    let state_token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &state_claims,
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .map_err(|e| CloudError::Internal(format!("failed to encode state JWT: {e}")))?;

    let redirect_uri = format!("{}/api/accounts/callback/gmail", state.config.base_url);

    let authorize_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&state={}",
        url_encode(client_id),
        url_encode(&redirect_uri),
        url_encode("https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/userinfo.email"),
        url_encode(&state_token),
    );

    Ok(Json(AuthorizeUrlResponse { authorize_url }))
}

#[derive(Deserialize)]
pub struct GmailCallbackQuery {
    pub code: String,
    pub state: String,
}

/// GET /api/accounts/callback/gmail — Google OAuth callback (browser redirect)
pub async fn callback_gmail(
    State(state): State<AppState>,
    Query(params): Query<GmailCallbackQuery>,
) -> Result<Redirect, CloudError> {
    // Verify the state JWT to recover user_id
    let claims = crate::auth::verify_jwt(&params.state, &state.config.jwt_secret)?;
    let user_id = claims.sub;

    let client_id =
        state
            .config
            .gmail_client_id
            .as_deref()
            .ok_or(CloudError::ServiceUnavailable(
                "Gmail OAuth not configured".to_string(),
            ))?;
    let client_secret =
        state
            .config
            .gmail_client_secret
            .as_deref()
            .ok_or(CloudError::ServiceUnavailable(
                "Gmail OAuth not configured".to_string(),
            ))?;
    let redirect_uri = format!("{}/api/accounts/callback/gmail", state.config.base_url);

    // Exchange code for tokens
    let client = reqwest::Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", params.code.as_str()),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", &redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("token exchange failed: {e}")))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(CloudError::Internal(format!(
            "Google token exchange failed: {body}"
        )));
    }

    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let access_token = body["access_token"].as_str().ok_or(CloudError::Internal(
        "no access_token in response".to_string(),
    ))?;
    let refresh_token = body["refresh_token"].as_str().ok_or(CloudError::Internal(
        "no refresh_token in response — try revoking app access and reconnecting".to_string(),
    ))?;
    let expires_in = body["expires_in"].as_i64().unwrap_or(3600);

    // Encrypt tokens
    let encrypted_access =
        crate::services::email_service::encrypt_token(access_token, &state.config.encryption_key)?;
    let encrypted_refresh =
        crate::services::email_service::encrypt_token(refresh_token, &state.config.encryption_key)?;
    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(expires_in);

    // Upsert into connected_accounts
    sqlx::query(
        r#"
        INSERT INTO connected_accounts (user_id, provider, encrypted_access_token, encrypted_refresh_token, token_expires_at)
        VALUES ($1, 'gmail', $2, $3, $4)
        ON CONFLICT (user_id, provider) DO UPDATE SET
            encrypted_access_token = $2,
            encrypted_refresh_token = $3,
            token_expires_at = $4,
            updated_at = now()
        "#,
    )
    .bind(user_id)
    .bind(&encrypted_access)
    .bind(&encrypted_refresh)
    .bind(expires_at)
    .execute(&state.db)
    .await?;

    tracing::info!(%user_id, "Gmail OAuth connected");

    // Redirect back to settings
    let redirect_url = format!(
        "{}/settings?tab=accounts&gmail=connected",
        state.config.base_url
    );
    Ok(Redirect::to(&redirect_url))
}

#[derive(Serialize)]
pub struct AccountStatus {
    pub provider: String,
    pub connected: bool,
    pub connected_at: Option<DateTime<Utc>>,
}

/// GET /api/accounts/status — List connected account statuses
pub async fn accounts_status(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<Vec<AccountStatus>>, CloudError> {
    let rows = sqlx::query_as::<_, (String, DateTime<Utc>)>(
        "SELECT provider, created_at FROM connected_accounts WHERE user_id = $1",
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    let statuses: Vec<AccountStatus> = rows
        .into_iter()
        .map(|(provider, created_at)| AccountStatus {
            provider,
            connected: true,
            connected_at: Some(created_at),
        })
        .collect();

    Ok(Json(statuses))
}
