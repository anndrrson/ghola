use serde::Deserialize;

use crate::error::HomeError;

const OLLAMA_BASE: &str = "http://localhost:11434";

#[derive(Debug, Deserialize)]
struct TagsResponse {
    models: Vec<ModelInfo>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ModelInfo {
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub modified_at: String,
}

/// Check if Ollama is responding.
pub async fn is_running() -> bool {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_default();
    client
        .get(format!("{OLLAMA_BASE}/api/tags"))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Check if Ollama.app is installed.
pub fn is_installed() -> bool {
    std::path::Path::new("/Applications/Ollama.app").exists()
}

/// List locally available models.
pub async fn list_models() -> Result<Vec<ModelInfo>, HomeError> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{OLLAMA_BASE}/api/tags"))
        .send()
        .await
        .map_err(|e| HomeError::ServiceUnavailable(format!("Ollama not reachable: {e}")))?;

    if !resp.status().is_success() {
        return Err(HomeError::ServiceUnavailable(
            "Ollama returned an error".into(),
        ));
    }

    let tags: TagsResponse = resp
        .json()
        .await
        .map_err(|e| HomeError::Internal(format!("failed to parse Ollama response: {e}")))?;

    Ok(tags.models)
}

/// Pull a model from Ollama (returns streaming NDJSON progress).
/// Returns the raw response for streaming to the client.
pub async fn pull_model(name: &str) -> Result<reqwest::Response, HomeError> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{OLLAMA_BASE}/api/pull"))
        .json(&serde_json::json!({ "name": name }))
        .send()
        .await
        .map_err(|e| HomeError::ServiceUnavailable(format!("Ollama not reachable: {e}")))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(HomeError::Internal(format!("Ollama pull failed: {body}")));
    }

    Ok(resp)
}
