use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::CloudError;
use crate::state::AppState;

const TOKEN_2022_PROGRAM_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SGT_MINT_AUTHORITY: &str = "GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4";
const SGT_METADATA_ADDRESS: &str = "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te";
const SGT_GROUP_MINT_ADDRESS: &str = "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te";

#[derive(Debug, Deserialize)]
pub struct VerifySeekerRequest {
    pub wallet_pubkey: String,
    pub message: String,
    /// Base64-encoded 64-byte Ed25519 detached signature over `message`.
    pub signature: String,
}

#[derive(Debug, Serialize)]
pub struct VerifySeekerResponse {
    pub verified: bool,
    pub wallet_pubkey: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sgt_mint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub async fn verify_seeker_wallet(
    state: &AppState,
    user_id: uuid::Uuid,
    req: VerifySeekerRequest,
) -> Result<VerifySeekerResponse, CloudError> {
    validate_wallet_matches_user(state, user_id, &req.wallet_pubkey).await?;
    validate_proof(&req)?;

    let client = reqwest::Client::new();
    let mints =
        token_2022_mints_for_owner(&client, &state.config.solana_rpc_url, &req.wallet_pubkey)
            .await?;
    let sgt_mint = find_verified_sgt_mint(&client, &state.config.solana_rpc_url, &mints).await?;

    if let Some(mint) = sgt_mint {
        sqlx::query(
            r#"
            UPDATE users
            SET seeker_verified_at = now(),
                seeker_wallet_pubkey = $2,
                seeker_sgt_mint = $3
            WHERE id = $1
            "#,
        )
        .bind(user_id)
        .bind(&req.wallet_pubkey)
        .bind(&mint)
        .execute(&state.db)
        .await?;

        Ok(VerifySeekerResponse {
            verified: true,
            wallet_pubkey: req.wallet_pubkey,
            sgt_mint: Some(mint),
            reason: None,
        })
    } else {
        Ok(VerifySeekerResponse {
            verified: false,
            wallet_pubkey: req.wallet_pubkey,
            sgt_mint: None,
            reason: Some("connected wallet does not hold a verified Seeker Genesis Token".into()),
        })
    }
}

async fn validate_wallet_matches_user(
    state: &AppState,
    user_id: uuid::Uuid,
    wallet_pubkey: &str,
) -> Result<(), CloudError> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT siws_pubkey FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((Some(siws_pubkey),)) = row else {
        return Err(CloudError::Unauthorized);
    };
    if siws_pubkey != wallet_pubkey {
        return Err(CloudError::Unauthorized);
    }
    Ok(())
}

fn validate_proof(req: &VerifySeekerRequest) -> Result<(), CloudError> {
    if !req.message.contains("Ghola Seeker verification")
        || !req
            .message
            .contains(&format!("wallet={}", req.wallet_pubkey))
    {
        return Err(CloudError::BadRequest(
            "invalid seeker verification message".into(),
        ));
    }
    let signature =
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &req.signature)
            .map_err(|e| {
                CloudError::BadRequest(format!("invalid seeker signature encoding: {e}"))
            })?;
    crate::auth::verify_siws(&req.wallet_pubkey, req.message.as_bytes(), &signature)
}

async fn rpc(
    client: &reqwest::Client,
    rpc_url: &str,
    method: &str,
    params: Value,
) -> Result<Value, CloudError> {
    let resp = client
        .post(rpc_url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": "ghola-seeker",
            "method": method,
            "params": params,
        }))
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Seeker RPC request failed: {e}")))?
        .json::<Value>()
        .await
        .map_err(|e| CloudError::Internal(format!("Seeker RPC response parse failed: {e}")))?;
    if let Some(error) = resp.get("error") {
        return Err(CloudError::ServiceUnavailable(format!(
            "Seeker Genesis verification RPC unavailable: {error}"
        )));
    }
    resp.get("result")
        .cloned()
        .ok_or_else(|| CloudError::Internal("missing Seeker RPC result".into()))
}

async fn token_2022_mints_for_owner(
    client: &reqwest::Client,
    rpc_url: &str,
    owner: &str,
) -> Result<Vec<String>, CloudError> {
    let mut all = Vec::new();
    let mut pagination_key: Option<String> = None;
    loop {
        let mut config = json!({
            "encoding": "jsonParsed",
            "limit": 1000,
        });
        if let Some(key) = pagination_key.as_deref() {
            config["paginationKey"] = Value::String(key.to_string());
        }
        let result = rpc(
            client,
            rpc_url,
            "getTokenAccountsByOwnerV2",
            json!([owner, { "programId": TOKEN_2022_PROGRAM_ID }, config]),
        )
        .await?;
        let accounts = result
            .get("value")
            .and_then(|v| v.get("accounts").or(Some(v)))
            .and_then(Value::as_array)
            .ok_or_else(|| CloudError::Internal("unexpected SGT account response".into()))?;
        for account in accounts {
            let Some(info) = account.pointer("/account/data/parsed/info") else {
                continue;
            };
            let Some(mint) = info.get("mint").and_then(Value::as_str) else {
                continue;
            };
            let amount = info
                .pointer("/tokenAmount/amount")
                .and_then(Value::as_str)
                .unwrap_or("0");
            if amount != "0" {
                all.push(mint.to_string());
            }
        }
        pagination_key = result
            .get("paginationKey")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if pagination_key.is_none() {
            break;
        }
    }
    all.sort();
    all.dedup();
    Ok(all)
}

async fn find_verified_sgt_mint(
    client: &reqwest::Client,
    rpc_url: &str,
    mints: &[String],
) -> Result<Option<String>, CloudError> {
    for chunk in mints.chunks(100) {
        let result = rpc(
            client,
            rpc_url,
            "getMultipleAccounts",
            json!([chunk, { "encoding": "jsonParsed" }]),
        )
        .await?;
        let Some(accounts) = result.get("value").and_then(Value::as_array) else {
            continue;
        };
        for (idx, account) in accounts.iter().enumerate() {
            let Some(info) = account.pointer("/data/parsed/info") else {
                continue;
            };
            if is_sgt_mint(info) {
                return Ok(chunk.get(idx).cloned());
            }
        }
    }
    Ok(None)
}

fn is_sgt_mint(info: &Value) -> bool {
    let mint_authority = info.get("mintAuthority").and_then(Value::as_str);
    if mint_authority != Some(SGT_MINT_AUTHORITY) {
        return false;
    }
    let Some(extensions) = info.get("extensions").and_then(Value::as_array) else {
        return false;
    };
    let has_metadata = extensions.iter().any(|ext| {
        extension_name(ext).contains("metadata")
            && value_contains_pair(ext, "authority", SGT_MINT_AUTHORITY)
            && value_contains_pair(ext, "metadataaddress", SGT_METADATA_ADDRESS)
    });
    let has_group = extensions.iter().any(|ext| {
        extension_name(ext).contains("group")
            && value_contains_pair(ext, "group", SGT_GROUP_MINT_ADDRESS)
    });
    has_metadata && has_group
}

fn extension_name(value: &Value) -> String {
    value
        .get("extension")
        .or_else(|| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn value_contains_pair(value: &Value, key: &str, expected: &str) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(k, v)| {
            (k.to_ascii_lowercase() == key && v.as_str() == Some(expected))
                || value_contains_pair(v, key, expected)
        }),
        Value::Array(items) => items
            .iter()
            .any(|item| value_contains_pair(item, key, expected)),
        _ => false,
    }
}
