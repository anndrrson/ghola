use std::convert::Infallible;

use axum::extract::State;
use axum::response::sse::{Event, Sse};
use axum::Json;
use futures::stream::Stream;
use futures::StreamExt;
use serde::Deserialize;

use crate::auth::PairedDevice;
use crate::error::HomeError;
use crate::ollama;
use crate::state::HomeState;

pub async fn list_models(
    State(_state): State<HomeState>,
    PairedDevice(_device): PairedDevice,
) -> Result<Json<serde_json::Value>, HomeError> {
    let models = ollama::list_models().await?;
    let names: Vec<serde_json::Value> = models
        .into_iter()
        .map(|m| {
            serde_json::json!({
                "name": m.name,
                "size": m.size,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({ "models": names })))
}

#[derive(Deserialize)]
pub struct PullRequest {
    pub name: String,
}

pub async fn pull_model(
    State(_state): State<HomeState>,
    PairedDevice(_device): PairedDevice,
    Json(req): Json<PullRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, HomeError> {
    let resp = ollama::pull_model(&req.name).await?;

    let stream = async_stream::stream! {
        let mut byte_stream = resp.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = byte_stream.next().await {
            match chunk {
                Ok(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));

                    while let Some(pos) = buffer.find('\n') {
                        let line = buffer[..pos].to_string();
                        buffer = buffer[pos + 1..].to_string();

                        if line.trim().is_empty() {
                            continue;
                        }

                        // Forward Ollama's NDJSON progress as SSE events
                        yield Ok(Event::default()
                            .event("progress")
                            .data(line));
                    }
                }
                Err(e) => {
                    yield Ok(Event::default()
                        .event("error")
                        .data(serde_json::json!({ "error": e.to_string() }).to_string()));
                    break;
                }
            }
        }

        yield Ok(Event::default()
            .event("done")
            .data(serde_json::json!({ "status": "complete" }).to_string()));
    };

    Ok(Sse::new(stream))
}
