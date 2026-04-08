use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbUser {
    pub id: Uuid,
    pub email: String,
    /// Nullable since migration 018: Google sign-in users have no password.
    pub password_hash: Option<String>,
    pub account_type: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbBusinessProfile {
    pub id: Uuid,
    pub user_id: Uuid,
    pub did: String,
    pub business_name: String,
    pub handle: Option<String>,
    pub category: String,
    pub description: String,
    pub logo_url: Option<String>,
    pub website: String,
    pub verified_domain: Option<String>,
    pub verified_at: Option<DateTime<Utc>>,
    pub operating_hours: Option<serde_json::Value>,
    pub location: Option<serde_json::Value>,
    pub contact: Option<serde_json::Value>,
    pub services: serde_json::Value,
    pub policies: serde_json::Value,
    pub api_endpoints: serde_json::Value,
    pub payment_methods: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbDomainVerification {
    pub id: Uuid,
    pub profile_id: Uuid,
    pub domain: String,
    pub method: String,
    pub token: String,
    pub verified: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbUsageLog {
    pub id: Uuid,
    pub profile_id: Option<Uuid>,
    pub endpoint: String,
    pub client_ip: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DbPublicProfile {
    pub id: Uuid,
    pub user_id: Uuid,
    pub did: String,
    pub display_name: String,
    pub handle: Option<String>,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub timezone: Option<String>,
    pub agent_preferences: serde_json::Value,
    pub encrypted_wallet: Option<Vec<u8>>,
    pub on_chain_registered: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<DbPublicProfile> for said_types::PublicProfile {
    fn from(db: DbPublicProfile) -> Self {
        let prefs: said_types::AgentPreferences =
            serde_json::from_value(db.agent_preferences).unwrap_or_default();
        Self {
            did: db.did,
            display_name: db.display_name,
            handle: db.handle,
            avatar_url: db.avatar_url,
            bio: db.bio,
            timezone: db.timezone,
            agent_preferences: prefs,
            on_chain_registered: db.on_chain_registered,
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbAgentInteraction {
    pub id: Uuid,
    pub profile_id: Uuid,
    pub agent_identifier: Option<String>,
    pub tool_used: Option<String>,
    pub service_name: Option<String>,
    pub query_text: Option<String>,
    pub response_status: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbDiscoveryEvent {
    pub id: Uuid,
    pub profile_id: Option<Uuid>,
    pub event_type: String,
    pub source_domain: Option<String>,
    pub agent_identifier: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbVerifiedBadge {
    pub id: Uuid,
    pub profile_id: Uuid,
    pub verified_by: String,
    pub attestation_tx: Option<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbAgentWallet {
    pub id: Uuid,
    pub user_id: Uuid,
    pub label: String,
    pub hd_index: i32,
    pub solana_address: String,
    pub spending_policy: serde_json::Value,
    pub active: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Set when this wallet belongs to a cryptographically-owned agent
    /// (added by migration 017_agents.sql). NULL for legacy user-level wallets.
    pub agent_id: Option<Uuid>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbAgent {
    pub id: Uuid,
    pub user_id: Uuid,
    pub slug: String,
    pub display_name: String,
    pub bio: Option<String>,
    pub avatar_url: Option<String>,
    pub did: String,
    #[serde(skip)]
    pub master_pubkey: Vec<u8>,
    pub solana_address: String,
    pub wallet_id: Option<Uuid>,
    pub onchain_identity_pda: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbPaymentTransaction {
    pub id: Uuid,
    pub user_id: Uuid,
    pub agent_wallet_id: Uuid,
    pub agent_label: String,
    pub direction: String,
    pub currency: String,
    pub amount: i64,
    pub recipient: String,
    pub sender: String,
    pub signature: String,
    pub memo: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbMerchantConfig {
    pub id: Uuid,
    pub user_id: Uuid,
    pub did: String,
    pub receive_address: String,
    pub accepted_currencies: serde_json::Value,
    pub webhook_url: Option<String>,
    pub active: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbChatAgent {
    pub id: Uuid,
    pub user_id: Uuid,
    pub encrypted_config: String,
    pub display_order: i32,
    pub last_message_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbChatSnapshot {
    pub id: Uuid,
    pub user_id: Uuid,
    pub agent_id: Uuid,
    pub encrypted_messages: String,
    pub message_count: i32,
    pub snapshot_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbServiceListing {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub owner_did: String,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub logo_url: Option<String>,
    pub website: Option<String>,
    pub category: String,
    pub tags: Vec<String>,
    pub base_url: String,
    pub health_check_url: Option<String>,
    pub openapi_url: Option<String>,
    pub auth_type: String,
    pub auth_details: serde_json::Value,
    pub pricing_model: String,
    pub price_micro_usdc: i64,
    pub pricing_tiers: Option<serde_json::Value>,
    pub free_tier_requests: Option<i32>,
    pub sla_uptime_percent: Option<f32>,
    pub sla_latency_p50_ms: Option<i32>,
    pub sla_latency_p99_ms: Option<i32>,
    pub regions: Vec<String>,
    pub endpoints: serde_json::Value,
    pub status: String,
    pub uptime_percent: f32,
    pub avg_latency_ms: f32,
    pub total_requests: i64,
    pub total_revenue_micro_usdc: i64,
    pub avg_rating: Option<f32>,
    pub review_count: i32,
    pub consecutive_failures: i32,
    pub last_heartbeat_at: Option<DateTime<Utc>>,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub receive_address: Option<String>,
    pub platform_fee_bps: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbServiceReview {
    pub id: Uuid,
    pub service_id: Uuid,
    pub reviewer_id: Uuid,
    pub reviewer_did: Option<String>,
    pub rating: i32,
    pub comment: Option<String>,
    pub quality_score: Option<i32>,
    pub reliability_score: Option<i32>,
    pub latency_score: Option<i32>,
    pub value_score: Option<i32>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbServicePayment {
    pub id: Uuid,
    pub service_id: Uuid,
    pub payer_id: Option<Uuid>,
    pub payer_did: Option<String>,
    pub agent_wallet_id: Option<Uuid>,
    pub endpoint_name: Option<String>,
    pub amount_micro_usdc: i64,
    pub merchant_share_micro_usdc: i64,
    pub platform_share_micro_usdc: i64,
    pub status: String,
    pub tx_signature: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl From<DbBusinessProfile> for said_types::BusinessProfile {
    fn from(db: DbBusinessProfile) -> Self {
        said_types::BusinessProfile {
            did: db.did,
            business_name: db.business_name,
            handle: db.handle,
            category: db.category,
            description: db.description,
            logo_url: db.logo_url,
            website: db.website,
            verified_domain: db.verified_domain,
            verified_at: db.verified_at,
            operating_hours: db.operating_hours,
            location: db
                .location
                .and_then(|v| serde_json::from_value(v).ok()),
            contact: db.contact.and_then(|v| serde_json::from_value(v).ok()),
            services: serde_json::from_value(db.services).unwrap_or_default(),
            policies: serde_json::from_value(db.policies).unwrap_or_default(),
            api_endpoints: serde_json::from_value(db.api_endpoints).unwrap_or_default(),
            payment_methods: serde_json::from_value(db.payment_methods).unwrap_or_default(),
            created_at: db.created_at,
            updated_at: db.updated_at,
        }
    }
}
