//! SMS sending. Tries Bland AI first (it shares the call vendor's API key),
//! falls back to Twilio when its credentials are configured.

use uuid::Uuid;

use crate::error::CloudError;
use crate::state::AppState;

/// Result of a successful send: the vendor that delivered it plus the
/// vendor-side message id (for log correlation / future delivery webhooks).
pub struct SmsSendResult {
    pub vendor: &'static str,
    pub vendor_message_id: String,
}

/// Send an SMS. Mirrors `call_service::start_call` in shape — the route
/// owns DB inserts/updates; this function only talks to the vendor.
pub async fn send_sms(
    state: &AppState,
    _user_id: Uuid,
    _sms_id: Uuid,
    to: &str,
    body: &str,
) -> Result<SmsSendResult, CloudError> {
    if let Some(api_key) = state.config.bland_api_key.as_deref() {
        match send_via_bland(api_key, to, body).await {
            Ok(id) => {
                return Ok(SmsSendResult {
                    vendor: "bland",
                    vendor_message_id: id,
                });
            }
            Err(e) => {
                tracing::warn!("Bland AI SMS failed, considering Twilio fallback: {e}");
            }
        }
    }

    if let (Some(sid), Some(token), Some(from)) = (
        state.config.twilio_account_sid.as_deref(),
        state.config.twilio_auth_token.as_deref(),
        state.config.twilio_from_number.as_deref(),
    ) {
        let id = send_via_twilio(sid, token, from, to, body).await?;
        return Ok(SmsSendResult {
            vendor: "twilio",
            vendor_message_id: id,
        });
    }

    Err(CloudError::ServiceUnavailable(
        "No SMS vendor configured (set BLAND_API_KEY or TWILIO_* env vars)".into(),
    ))
}

async fn send_via_bland(api_key: &str, to: &str, body: &str) -> Result<String, CloudError> {
    let payload = serde_json::json!({
        "phone_number": to,
        "message": body,
    });

    let resp = reqwest::Client::new()
        .post("https://api.bland.ai/v1/sms/send")
        .header("Authorization", api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Bland SMS request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp.text().await.unwrap_or_default();
        return Err(CloudError::Internal(format!(
            "Bland SMS returned {status}: {error_body}"
        )));
    }

    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("Bland SMS parse failed: {e}")))?;

    let id = resp_body["message_id"]
        .as_str()
        .or_else(|| resp_body["id"].as_str())
        .unwrap_or("")
        .to_string();
    Ok(id)
}

async fn send_via_twilio(
    sid: &str,
    token: &str,
    from: &str,
    to: &str,
    body: &str,
) -> Result<String, CloudError> {
    let url = format!("https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json");
    let form = [("To", to), ("From", from), ("Body", body)];

    let resp = reqwest::Client::new()
        .post(&url)
        .basic_auth(sid, Some(token))
        .form(&form)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Twilio request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp.text().await.unwrap_or_default();
        return Err(CloudError::Internal(format!(
            "Twilio returned {status}: {error_body}"
        )));
    }

    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("Twilio parse failed: {e}")))?;

    let id = resp_body["sid"].as_str().unwrap_or("").to_string();
    Ok(id)
}
