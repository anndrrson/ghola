use reqwest::Client;
use serde::Deserialize;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
pub struct ResolvedNode {
    pub id: Uuid,
    pub endpoint_url: String,
    pub status: String,
    pub uptime_percent: f32,
    pub avg_latency_ms: Option<f32>,
    pub price_per_query_micro_usdc: i64,
}

pub struct NodeResolver {
    client: Client,
    said_cloud_url: String,
}

impl NodeResolver {
    pub fn new(client: &Client, said_cloud_url: &str) -> Self {
        Self {
            client: client.clone(),
            said_cloud_url: said_cloud_url.to_string(),
        }
    }

    /// Resolve healthy nodes for a model identifier from SAID Cloud.
    /// Returns empty vec on any error (graceful degradation).
    pub async fn resolve(&self, model_identifier: &str) -> Vec<ResolvedNode> {
        let url = format!(
            "{}/v1/nodes/resolve?model={}",
            self.said_cloud_url.trim_end_matches('/'),
            urlencoding::encode(model_identifier)
        );

        let result = self
            .client
            .get(&url)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await;

        match result {
            Ok(resp) if resp.status().is_success() => {
                #[derive(Deserialize)]
                struct Resp {
                    nodes: Vec<ResolvedNode>,
                }
                resp.json::<Resp>()
                    .await
                    .map(|r| r.nodes)
                    .unwrap_or_default()
            }
            _ => Vec::new(),
        }
    }
}
