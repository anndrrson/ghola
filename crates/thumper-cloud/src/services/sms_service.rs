use uuid::Uuid;

use crate::error::CloudError;
use crate::state::AppState;

/// Send an SMS via Bland AI.
///
/// Vendor chosen: Bland AI. Reuses `state.config.bland_api_key`. The sandbox
/// network policy blocked a live probe of `/v1/sms/send`; Bland publishes
/// this endpoint and we already trust them for `/v1/calls`. If a deploy-time
/// test reveals Bland SMS isn't usable on this account, the Twilio path is a
/// mechanical swap of the request body + URL.
pub async fn send_sms(
    state: &AppState,
    user_id: Uuid,
    to: &str,
    body: &str,
) -> Result<String, CloudError> {
    let api_key = state
        .config
        .bland_api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable(
            "Bland AI not configured".to_string(),
        ))?;

    let payload = serde_json::json!({
        "phone_number": to,
        "message": body,
    });

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.bland.ai/v1/sms/send")
        .header("Authorization", api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Bland SMS request failed: {e}")))?;

    let status = resp.status();
    if !status.is_success() {
        let _ = resp.text().await;
        return Err(CloudError::Internal(format!(
            "Bland SMS returned status {status}"
        )));
    }

    let resp_body: serde_json::Value = resp.json().await.unwrap_or_else(|_| serde_json::json!({}));

    let message_id = resp_body
        .get("message_id")
        .and_then(|v| v.as_str())
        .or_else(|| resp_body.get("id").and_then(|v| v.as_str()))
        .unwrap_or("unknown")
        .to_string();

    tracing::info!(
        user = %crate::privacy::log_id(&user_id),
        %message_id,
        "sms sent via Bland AI"
    );

    Ok(message_id)
}

/// Tool definition advertised to LLMs that support tool-use. Mirrors the
/// shape used by `wallet_service::wallet_tool_definitions`.
pub fn sms_tool_definition() -> serde_json::Value {
    serde_json::json!({
        "name": "send_sms",
        "description": "Send a text message (SMS) to a phone number on the user's behalf. \
                        The user will review the message before it actually sends.",
        "input_schema": {
            "type": "object",
            "properties": {
                "to": {
                    "type": "string",
                    "description": "Recipient phone number in E.164 format, e.g. +15551234567"
                },
                "body": {
                    "type": "string",
                    "description": "The text message body to send."
                }
            },
            "required": ["to", "body"]
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_definition_advertises_send_sms() {
        let def = sms_tool_definition();
        assert_eq!(def["name"], "send_sms");
        let req = def["input_schema"]["required"].as_array().unwrap();
        assert!(req.iter().any(|v| v == "to"));
        assert!(req.iter().any(|v| v == "body"));
    }

    #[test]
    fn tool_definition_input_schema_has_string_fields() {
        let def = sms_tool_definition();
        assert_eq!(def["input_schema"]["properties"]["to"]["type"], "string");
        assert_eq!(def["input_schema"]["properties"]["body"]["type"], "string");
    }
}
