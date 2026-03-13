use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
pub struct DbUser {
    pub id: Uuid,
    pub email: String,
    pub password_hash: String,
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
