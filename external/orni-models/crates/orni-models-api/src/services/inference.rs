use futures::StreamExt;
use orni_models_types::{InferenceChatMessage, InferenceChunk, InferenceRequest};
use reqwest::Client;
use tokio::sync::mpsc;

use crate::config::Config;
use crate::error::{AppError, AppResult};

pub struct InferenceService {
    client: Client,
    api_key: String,
    base_url: String,
}

impl InferenceService {
    pub fn new(config: &Config, client: &Client) -> Self {
        Self {
            client: client.clone(),
            api_key: config.together_api_key.clone(),
            base_url: config.together_base_url.clone(),
        }
    }

    /// Stream chat completion, sending content chunks through the channel.
    pub async fn chat_stream(
        &self,
        model_id: &str,
        messages: Vec<InferenceChatMessage>,
        tx: mpsc::Sender<String>,
    ) -> AppResult<()> {
        let request = InferenceRequest {
            model: model_id.to_string(),
            messages,
            stream: true,
            max_tokens: Some(1024),
            temperature: Some(0.7),
        };

        let response = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "Inference API error {status}: {body}"
            )));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::Internal(format!("Stream error: {e}")))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // Process SSE lines
            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer = buffer[line_end + 1..].to_string();

                if line.is_empty() || !line.starts_with("data: ") {
                    continue;
                }

                let data = &line[6..];
                if data == "[DONE]" {
                    return Ok(());
                }

                if let Ok(chunk) = serde_json::from_str::<InferenceChunk>(data) {
                    if let Some(choice) = chunk.choices.first() {
                        if let Some(delta) = &choice.delta {
                            if let Some(content) = &delta.content {
                                if tx.send(content.clone()).await.is_err() {
                                    return Ok(()); // Client disconnected
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(())
    }

    /// Stream from a self-hosted OpenAI-compatible endpoint.
    /// Validates the endpoint URL to prevent SSRF before making the request.
    pub async fn chat_stream_self_hosted(
        &self,
        endpoint_url: &str,
        model_id: &str,
        messages: Vec<InferenceChatMessage>,
        tx: mpsc::Sender<String>,
    ) -> AppResult<()> {
        // SSRF protection: only allow HTTPS endpoints (and localhost for dev)
        let url = endpoint_url.trim_end_matches('/');
        if !url.starts_with("https://")
            && !url.starts_with("http://localhost")
            && !url.starts_with("http://127.0.0.1")
        {
            return Err(AppError::BadRequest(
                "Self-hosted endpoint must use HTTPS".into(),
            ));
        }

        let request = InferenceRequest {
            model: model_id.to_string(),
            messages,
            stream: true,
            max_tokens: Some(1024),
            temperature: Some(0.7),
        };

        let response = self
            .client
            .post(format!("{url}/chat/completions"))
            .json(&request)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "Self-hosted inference error {status}: {body}"
            )));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::Internal(format!("Stream error: {e}")))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer = buffer[line_end + 1..].to_string();

                if line.is_empty() || !line.starts_with("data: ") {
                    continue;
                }

                let data = &line[6..];
                if data == "[DONE]" {
                    return Ok(());
                }

                if let Ok(chunk) = serde_json::from_str::<InferenceChunk>(data) {
                    if let Some(choice) = chunk.choices.first() {
                        if let Some(delta) = &choice.delta {
                            if let Some(content) = &delta.content {
                                if tx.send(content.clone()).await.is_err() {
                                    return Ok(());
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(())
    }

    /// Attempt to connect to a self-hosted endpoint.
    /// Returns the raw response on success for streaming later.
    pub async fn try_connect_self_hosted(
        &self,
        endpoint_url: &str,
        model_id: &str,
        messages: &[InferenceChatMessage],
    ) -> AppResult<reqwest::Response> {
        let request = InferenceRequest {
            model: model_id.to_string(),
            messages: messages.to_vec(),
            stream: true,
            max_tokens: Some(1024),
            temperature: Some(0.7),
        };

        let response = self
            .client
            .post(format!(
                "{}/chat/completions",
                endpoint_url.trim_end_matches('/')
            ))
            .timeout(std::time::Duration::from_secs(10))
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "Self-hosted inference error {status}: {body}"
            )));
        }

        Ok(response)
    }

    /// Stream an already-connected SSE response through the channel.
    pub async fn stream_response(
        response: reqwest::Response,
        tx: mpsc::Sender<String>,
    ) -> AppResult<()> {
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::Internal(format!("Stream error: {e}")))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer = buffer[line_end + 1..].to_string();

                if line.is_empty() || !line.starts_with("data: ") {
                    continue;
                }

                let data = &line[6..];
                if data == "[DONE]" {
                    return Ok(());
                }

                if let Ok(chunk) = serde_json::from_str::<InferenceChunk>(data) {
                    if let Some(choice) = chunk.choices.first() {
                        if let Some(delta) = &choice.delta {
                            if let Some(content) = &delta.content {
                                if tx.send(content.clone()).await.is_err() {
                                    return Ok(());
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(())
    }

    /// Non-streaming completion for internal use (e.g., training data generation).
    pub async fn chat_complete(
        &self,
        model_id: &str,
        messages: Vec<InferenceChatMessage>,
    ) -> AppResult<String> {
        let request = InferenceRequest {
            model: model_id.to_string(),
            messages,
            stream: false,
            max_tokens: Some(2048),
            temperature: Some(0.7),
        };

        let response = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "Inference API error {status}: {body}"
            )));
        }

        let chunk: InferenceChunk = response.json().await.map_err(|e| {
            AppError::Internal(format!("Failed to parse inference response: {e}"))
        })?;

        chunk
            .choices
            .first()
            .and_then(|c| c.message.as_ref())
            .and_then(|m| m.content.clone())
            .ok_or_else(|| AppError::Internal("Empty inference response".into()))
    }

    /// Create a fine-tuning job.
    pub async fn create_fine_tune(
        &self,
        base_model: &str,
        training_file_url: &str,
        suffix: &str,
    ) -> AppResult<String> {
        let body = serde_json::json!({
            "training_file": training_file_url,
            "model": base_model,
            "suffix": suffix,
            "n_epochs": 3,
        });

        let response = self
            .client
            .post(format!("{}/fine-tuning/jobs", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await?;

        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!("Fine-tune API error: {body}")));
        }

        let result: serde_json::Value = response.json().await?;
        result["id"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| AppError::Internal("Missing fine-tune job ID".into()))
    }

    /// Check fine-tuning job status.
    pub async fn get_fine_tune_status(
        &self,
        job_id: &str,
    ) -> AppResult<(String, Option<String>)> {
        let response = self
            .client
            .get(format!("{}/fine-tuning/jobs/{}", self.base_url, job_id))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .send()
            .await?;

        let result: serde_json::Value = response.json().await?;
        let status = result["status"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        let model_id = result["fine_tuned_model"].as_str().map(String::from);

        Ok((status, model_id))
    }
}
