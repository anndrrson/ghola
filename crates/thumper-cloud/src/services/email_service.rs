use uuid::Uuid;

use crate::error::CloudError;
use crate::state::AppState;

pub struct EmailDraft {
    pub to_address: String,
    pub subject: String,
    pub body: String,
}

/// Generate an email draft using Claude.
pub async fn generate_email_draft(
    state: &AppState,
    user_id: Uuid,
    intent: &str,
    context: Option<&str>,
    tone: Option<&str>,
) -> Result<EmailDraft, CloudError> {
    // Fetch user info for personalization
    let user_info = sqlx::query_as::<_, (Option<String>, Option<String>)>(
        "SELECT display_name, email FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    let (display_name, _user_email) = user_info.unwrap_or((None, None));
    let name = display_name.unwrap_or_else(|| "the user".to_string());
    let tone = tone.unwrap_or("professional but friendly");

    let context_section = context
        .map(|c| format!("\nAdditional context: {c}"))
        .unwrap_or_default();

    let prompt = format!(
        r#"Draft an email for the following request:

Request: {intent}{context_section}

Sender name: {name}
Tone: {tone}

Return a JSON object with:
- "to_address": The recipient's email address (if you can infer it, otherwise use "recipient@example.com")
- "subject": A clear, concise subject line
- "body": The full email body (plain text, no HTML)

The email should be ready to send — professional, clear, and complete. Sign it with the sender's name."#
    );

    let result = crate::services::llm_router::generate(state, user_id, &prompt, Some("json")).await?;

    let parsed: serde_json::Value = serde_json::from_str(&result).map_err(|_| {
        CloudError::Internal("failed to parse LLM response as JSON".to_string())
    })?;

    Ok(EmailDraft {
        to_address: parsed["to_address"]
            .as_str()
            .unwrap_or("recipient@example.com")
            .to_string(),
        subject: parsed["subject"]
            .as_str()
            .unwrap_or("(No subject)")
            .to_string(),
        body: parsed["body"]
            .as_str()
            .unwrap_or("")
            .to_string(),
    })
}

/// Send an email via Gmail API using the user's connected account.
pub async fn send_via_gmail(
    state: &AppState,
    user_id: Uuid,
    to: &str,
    cc: &[String],
    subject: &str,
    body: &str,
) -> Result<String, CloudError> {
    // Get the user's Gmail OAuth tokens
    let tokens = get_gmail_tokens(state, user_id).await?;

    // Build RFC 2822 message
    let cc_header = if cc.is_empty() {
        String::new()
    } else {
        format!("Cc: {}\r\n", cc.join(", "))
    };

    let raw_message = format!(
        "To: {to}\r\n{cc_header}Subject: {subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}"
    );

    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(raw_message.as_bytes());

    let client = reqwest::Client::new();
    let resp = client
        .post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
        .header("Authorization", format!("Bearer {}", tokens.access_token))
        .json(&serde_json::json!({ "raw": encoded }))
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Gmail API request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp.text().await.unwrap_or_default();

        // If token expired, try refreshing
        if status.as_u16() == 401 {
            return Err(CloudError::Auth(
                "Gmail token expired — user needs to re-authenticate".to_string(),
            ));
        }

        return Err(CloudError::Internal(format!(
            "Gmail API returned {status}: {error_body}"
        )));
    }

    let resp_body: serde_json::Value = resp.json().await.unwrap_or_default();
    let message_id = resp_body["id"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();

    tracing::info!(%user_id, %message_id, %to, "email sent via Gmail");

    Ok(message_id)
}

use base64::Engine;

struct GmailTokens {
    access_token: String,
}

async fn get_gmail_tokens(state: &AppState, user_id: Uuid) -> Result<GmailTokens, CloudError> {
    let row = sqlx::query_as::<_, (Vec<u8>, Vec<u8>, Option<chrono::DateTime<chrono::Utc>>)>(
        r#"
        SELECT encrypted_access_token, encrypted_refresh_token, token_expires_at
        FROM connected_accounts
        WHERE user_id = $1 AND provider = 'gmail'
        "#,
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::BadRequest(
        "Gmail not connected — connect your account first".to_string(),
    ))?;

    let access_token = decrypt_token(&row.0, &state.config.encryption_key)?;

    // Check if token is expired and needs refresh
    if let Some(expires_at) = row.2 {
        if expires_at < chrono::Utc::now() {
            let refresh_token = decrypt_token(&row.1, &state.config.encryption_key)?;
            return refresh_gmail_token(state, user_id, &refresh_token).await;
        }
    }

    Ok(GmailTokens { access_token })
}

async fn refresh_gmail_token(
    state: &AppState,
    user_id: Uuid,
    refresh_token: &str,
) -> Result<GmailTokens, CloudError> {
    let client_id = state.config.gmail_client_id.as_deref()
        .ok_or(CloudError::ServiceUnavailable("Gmail OAuth not configured".to_string()))?;
    let client_secret = state.config.gmail_client_secret.as_deref()
        .ok_or(CloudError::ServiceUnavailable("Gmail OAuth not configured".to_string()))?;

    let client = reqwest::Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("token refresh failed: {e}")))?;

    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let new_access_token = body["access_token"]
        .as_str()
        .ok_or(CloudError::Internal("no access_token in refresh response".to_string()))?;
    let expires_in = body["expires_in"].as_i64().unwrap_or(3600);

    // Update stored tokens
    let encrypted = encrypt_token(new_access_token, &state.config.encryption_key)?;
    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(expires_in);

    sqlx::query(
        r#"
        UPDATE connected_accounts SET
            encrypted_access_token = $1,
            token_expires_at = $2,
            updated_at = now()
        WHERE user_id = $3 AND provider = 'gmail'
        "#,
    )
    .bind(&encrypted)
    .bind(expires_at)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    Ok(GmailTokens {
        access_token: new_access_token.to_string(),
    })
}

pub fn encrypt_token(plaintext: &str, key: &[u8; 32]) -> Result<Vec<u8>, CloudError> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Nonce,
    };

    let cipher = Aes256Gcm::new(key.into());
    let mut nonce_bytes = [0u8; 12];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| CloudError::Internal(format!("encryption failed: {e}")))?;

    // Prepend nonce to ciphertext
    let mut result = nonce_bytes.to_vec();
    result.extend(ciphertext);
    Ok(result)
}

fn decrypt_token(data: &[u8], key: &[u8; 32]) -> Result<String, CloudError> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Nonce,
    };

    if data.len() < 12 {
        return Err(CloudError::Internal("encrypted data too short".to_string()));
    }

    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| CloudError::Internal(format!("decryption failed: {e}")))?;

    String::from_utf8(plaintext)
        .map_err(|e| CloudError::Internal(format!("invalid UTF-8 after decrypt: {e}")))
}
