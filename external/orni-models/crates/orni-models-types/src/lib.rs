use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ── Database Models ──

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub wallet_address: Option<String>,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub is_creator: bool,
    pub usdc_balance: i64, // in micro-USDC (6 decimals)
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    // Email auth fields
    pub email: Option<String>,
    #[serde(skip_serializing)]
    pub password_hash: Option<String>,
    pub stripe_customer_id: Option<String>,
    pub slug: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::Type, PartialEq)]
#[sqlx(type_name = "model_status", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum ModelStatus {
    Draft,
    Training,
    Live,
    Paused,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Model {
    pub id: Uuid,
    pub creator_id: Uuid,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub avatar_url: Option<String>,
    pub system_prompt: String,
    pub base_model: String,
    pub provider_model_id: Option<String>,
    pub status: ModelStatus,
    pub price_per_query: i64, // micro-USDC
    pub total_queries: i64,
    pub total_revenue: i64,
    pub category: Option<String>,
    pub tags: Vec<String>,
    pub self_hosted_node_id: Option<Uuid>,
    pub self_hosted_endpoint: Option<String>,
    pub is_featured: bool,
    pub is_platform_model: bool,
    pub free_queries_per_day: i32,
    pub avg_rating: f64,
    pub review_count: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    // Foundation catalog metadata (Phase 1).
    pub params_b: Option<f64>,
    pub active_params_b: Option<f64>,
    pub license: Option<String>,
    pub license_url: Option<String>,
    pub developer: Option<String>,
    pub architecture: Option<String>,
    pub context_window: Option<i32>,
    pub modality: Vec<String>,
    pub hf_id: Option<String>,
    pub release_date: Option<chrono::NaiveDate>,
    pub is_foundation: bool,
    pub gguf_available: bool,
    pub recommended_vram_gb: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::Type, PartialEq)]
#[sqlx(type_name = "source_type", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum SourceType {
    Text,
    Pdf,
    Youtube,
    Blog,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::Type, PartialEq)]
#[sqlx(type_name = "content_status", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum ContentStatus {
    Pending,
    Processing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ContentSource {
    pub id: Uuid,
    pub model_id: Uuid,
    pub source_type: SourceType,
    pub source_url: Option<String>,
    pub content_text: Option<String>,
    pub status: ContentStatus,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct TrainingDataset {
    pub id: Uuid,
    pub model_id: Uuid,
    pub file_key: String,
    pub num_examples: i32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::Type, PartialEq)]
#[sqlx(type_name = "fine_tune_status", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum FineTuneStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct FineTuneJob {
    pub id: Uuid,
    pub model_id: Uuid,
    pub provider_job_id: Option<String>,
    pub status: FineTuneStatus,
    pub result_model_id: Option<String>,
    pub error_message: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ChatSession {
    pub id: Uuid,
    pub user_id: Uuid,
    pub model_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::Type, PartialEq)]
#[sqlx(type_name = "chat_role", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ChatMessage {
    pub id: Uuid,
    pub session_id: Uuid,
    pub role: ChatRole,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Payment {
    pub id: Uuid,
    pub user_id: Uuid,
    pub model_id: Uuid,
    pub amount: i64,
    pub creator_share: i64,
    pub platform_share: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Deposit {
    pub id: Uuid,
    pub user_id: Uuid,
    pub amount: i64,
    pub tx_signature: String,
    pub verified: bool,
    pub created_at: DateTime<Utc>,
    /// Stablecoin symbol (e.g. "USDT", "USDC"). Default 'USDC' for pre-migration rows.
    #[serde(default = "default_currency")]
    pub currency: String,
}

fn default_currency() -> String {
    "USDC".to_string()
}

/// Per-currency balance row from the currency_balances table.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct CurrencyBalance {
    pub currency: String,
    pub balance: i64,
}

// ── API DTOs ──

#[derive(Debug, Deserialize)]
pub struct NonceRequest {
    pub wallet_address: String,
}

#[derive(Debug, Serialize)]
pub struct NonceResponse {
    pub nonce: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct VerifyRequest {
    pub wallet_address: String,
    pub signature: String,
    pub nonce: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: User,
}

#[derive(Debug, Deserialize)]
pub struct EmailRegisterRequest {
    pub email: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EmailLoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct CheckoutRequest {
    pub pack: String, // "5", "10", "25", "50"
}

#[derive(Debug, Deserialize)]
pub struct CreateModelRequest {
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub base_model: Option<String>,
    pub price_per_query: Option<i64>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
    pub self_hosted_endpoint: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct QuickListRequest {
    pub endpoint_url: String,
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct QuickListResponse {
    pub model: Model,
    pub detected_models: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateModelRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
    pub price_per_query: Option<i64>,
    pub status: Option<ModelStatus>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ModelCard {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub avatar_url: Option<String>,
    pub creator_name: Option<String>,
    pub creator_wallet: Option<String>,
    pub status: ModelStatus,
    pub price_per_query: i64,
    pub total_queries: i64,
    pub category: Option<String>,
    pub tags: Vec<String>,
    pub creator_did: Option<String>,
    pub creator_verified: bool,
    pub is_featured: bool,
    pub free_queries_per_day: i32,
    // Foundation catalog metadata surfaced on browse cards.
    pub is_foundation: bool,
    pub developer: Option<String>,
    pub params_b: Option<f64>,
    pub active_params_b: Option<f64>,
    pub license: Option<String>,
    pub context_window: Option<i32>,
    pub modality: Vec<String>,
    // Derived: provider_model_id IS NULL AND self_hosted_endpoint IS NULL AND self_hosted_node_id IS NULL
    pub awaiting_host: bool,
}

#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub message: String,
    pub session_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct ChatStartResponse {
    pub session_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct AddContentRequest {
    pub source_type: SourceType,
    pub source_url: Option<String>,
    pub content_text: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DepositRequest {
    pub tx_signature: String,
    pub amount: i64,
    /// Stablecoin used for this deposit (e.g. "USDT"). Optional — when omitted
    /// the on-chain verifier determines it from the transaction.
    #[serde(default)]
    pub currency: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BalanceResponse {
    /// Per-currency balances. Each entry is in the smallest unit (micro-units
    /// for 6-decimal stablecoins).
    pub balances: Vec<CurrencyBalance>,
    /// Sum of outstanding creator earnings, in USD micro-units (1:1 with either stablecoin).
    pub pending_earnings: i64,
}

#[derive(Debug, Deserialize)]
pub struct WithdrawRequest {
    pub amount: i64,
    pub destination_wallet: String,
    /// Stablecoin to withdraw (e.g. "USDT"). Defaults to the platform's primary
    /// stablecoin when omitted.
    #[serde(default)]
    pub currency: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MarketplaceQuery {
    pub search: Option<String>,
    pub category: Option<String>,
    pub sort: Option<String>,
    pub page: Option<i64>,
    pub limit: Option<i64>,
    pub is_foundation: Option<bool>,
    pub developer: Option<String>,
    pub license: Option<String>,
    pub min_params: Option<f64>,
    pub max_params: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct ModelInterestRequest {
    pub email: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ModelInterestResponse {
    pub registered: bool,
}

#[derive(Debug, Serialize)]
pub struct MarketplaceResponse {
    pub models: Vec<ModelCard>,
    pub total: i64,
    pub page: i64,
    pub limit: i64,
}

// ── Identity Linking Types ──

#[derive(Debug, Deserialize)]
pub struct LinkDidRequest {
    pub did: String,
    pub said_token: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CreatorProfile {
    pub wallet_address: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub did: Option<String>,
    pub said_verified: bool,
    pub said_profile_url: Option<String>,
    pub model_count: Option<i64>,
    pub total_queries: Option<i64>,
}

// ── Inference Types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct InferenceRequest {
    pub model: String,
    pub messages: Vec<InferenceChatMessage>,
    pub stream: bool,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

#[derive(Debug, Deserialize)]
pub struct InferenceChoice {
    pub delta: Option<InferenceDelta>,
    pub message: Option<InferenceDelta>,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct InferenceDelta {
    pub role: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct InferenceChunk {
    pub choices: Vec<InferenceChoice>,
}

#[derive(Debug, Serialize)]
pub struct FineTuneRequest {
    pub training_file: String,
    pub model: String,
    pub suffix: String,
    pub n_epochs: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct FineTuneResponse {
    pub id: String,
    pub status: String,
    pub fine_tuned_model: Option<String>,
}

// ── Creator Dashboard Types ──

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CreatorStats {
    pub total_models: i64,
    pub total_queries: i64,
    pub total_revenue: i64,
    pub pending_earnings: i64,
}

#[derive(Debug, Serialize)]
pub struct CreatorModelDetail {
    pub model: Model,
    pub content_sources: Vec<ContentSource>,
    pub fine_tune_jobs: Vec<FineTuneJob>,
    pub recent_queries: i64,
    pub recent_revenue: i64,
}

// ── Chat Session Types ──

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SessionSummary {
    pub id: Uuid,
    pub model_id: Uuid,
    pub model_name: String,
    pub model_slug: String,
    pub last_message: Option<String>,
    pub message_count: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// ── API Key Types ──

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ApiKey {
    pub id: Uuid,
    pub user_id: Uuid,
    pub model_id: Uuid,
    pub key_hash: String,
    pub key_prefix: String,
    pub name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub is_active: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateApiKeyRequest {
    pub model_id: Uuid,
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateApiKeyResponse {
    pub id: Uuid,
    pub key: String,
    pub key_prefix: String,
    pub name: Option<String>,
    pub model_id: Uuid,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ApiKeyInfo {
    pub id: Uuid,
    pub key_prefix: String,
    pub name: Option<String>,
    pub model_id: Uuid,
    pub model_name: Option<String>,
    pub model_slug: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub is_active: bool,
}

// ── OpenAI-Compatible Types ──

#[derive(Debug, Deserialize)]
pub struct OpenAIChatRequest {
    pub model: String,
    pub messages: Vec<InferenceChatMessage>,
    pub stream: Option<bool>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

// ── Model Review Types ──

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ModelReview {
    pub id: Uuid,
    pub user_id: Uuid,
    pub model_id: Uuid,
    pub rating: i32,
    pub review_text: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ReviewWithUser {
    pub id: Uuid,
    pub rating: i32,
    pub review_text: Option<String>,
    pub created_at: DateTime<Utc>,
    pub user_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateReviewRequest {
    pub rating: i32,
    pub review_text: Option<String>,
}

// ── Creator Public Profile Types ──

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CreatorPublicProfile {
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub slug: Option<String>,
    pub did: Option<String>,
    pub said_verified: bool,
    pub model_count: i64,
    pub total_queries: i64,
    pub created_at: DateTime<Utc>,
}

// ── Earnings Types ──

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct DailyEarning {
    pub date: chrono::NaiveDate,
    pub amount: i64,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ModelEarning {
    pub model_id: Uuid,
    pub model_name: String,
    pub model_slug: String,
    pub total_revenue: i64,
    pub creator_earnings: i64,
    pub query_count: i64,
}

#[derive(Debug, Serialize)]
pub struct EarningsResponse {
    pub daily: Vec<DailyEarning>,
    pub per_model: Vec<ModelEarning>,
    pub total_earnings: i64,
    pub total_revenue: i64,
}

// ── Usage Display Types ──

#[derive(Debug, Serialize)]
pub struct UsageResponse {
    pub used: i32,
    pub limit: i32,
    pub is_free: bool,
}

// ── Status Toggle Types ──

#[derive(Debug, Deserialize)]
pub struct StatusToggleRequest {
    pub status: ModelStatus,
}
