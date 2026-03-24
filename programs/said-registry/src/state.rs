use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct IdentityRecord {
    /// The authority that can manage this identity (initially the payer).
    pub authority: Pubkey,
    /// The Ed25519 master public key from the SAID wallet.
    pub master_pubkey: [u8; 32],
    /// The DID key string (e.g. "did:key:z6Mk...").
    #[max_len(64)]
    pub did_key: String,
    /// URI to the SAID profile (e.g. "https://api.said.id/v1/profile/did:key:z6Mk...")
    #[max_len(128)]
    pub profile_uri: String,
    /// Unix timestamp when the identity was registered.
    pub registered_at: i64,
    /// Unix timestamp when the identity was last updated.
    pub updated_at: i64,
    /// Whether the identity is currently active.
    pub active: bool,
    /// PDA bump seed.
    pub bump: u8,
}

/// On-chain record for a registered headless merchant service.
/// PDA seeds: ["service", identity_record.key(), slug.as_bytes()]
#[account]
#[derive(InitSpace)]
pub struct ServiceRecord {
    /// Authority that can manage this service (must match identity authority).
    pub authority: Pubkey,
    /// The IdentityRecord PDA this service belongs to.
    pub identity_record: Pubkey,
    /// URL-safe slug identifier (e.g. "acme-weather-api").
    #[max_len(64)]
    pub slug: String,
    /// Base URL of the service API.
    #[max_len(128)]
    pub base_url: String,
    /// URL to the SAID registry entry for this service.
    #[max_len(128)]
    pub registry_url: String,
    /// Price per request in micro USDC (6 decimals).
    pub price_micro_usdc: u64,
    /// Unix timestamp when registered.
    pub registered_at: i64,
    /// Unix timestamp when last updated.
    pub updated_at: i64,
    /// Whether the service is currently active.
    pub active: bool,
    /// PDA bump seed.
    pub bump: u8,
}

/// On-chain reputation attestation, written periodically by the SAID platform.
/// PDA seeds: ["reputation", entity_identity.key()]
#[account]
#[derive(InitSpace)]
pub struct ReputationAttestation {
    /// Platform authority that created this attestation.
    pub authority: Pubkey,
    /// The IdentityRecord PDA this attestation is for.
    pub entity: Pubkey,
    /// Overall trust score (0-10000, representing 0.0000 - 1.0000).
    pub overall_score: u16,
    /// Confidence level (0-10000).
    pub confidence: u16,
    /// Total completed transactions at time of attestation.
    pub total_transactions: u32,
    /// Unix timestamp of attestation.
    pub attested_at: i64,
    /// PDA bump seed.
    pub bump: u8,
}

/// On-chain delegation record — proves agent X delegated capabilities to agent Y.
/// PDA seeds: ["delegation", issuer.key(), audience.key(), token_hash]
#[account]
#[derive(InitSpace)]
pub struct DelegationRecord {
    /// IdentityRecord PDA of the issuer.
    pub issuer: Pubkey,
    /// IdentityRecord PDA of the audience.
    pub audience: Pubkey,
    /// SHA-256 of sorted capability strings.
    pub capabilities_hash: [u8; 32],
    /// SHA-256 of the UCAN JWT.
    pub token_hash: [u8; 32],
    /// Unix timestamp when delegation expires.
    pub expires_at: i64,
    /// Whether this delegation has been revoked.
    pub revoked: bool,
    /// Unix timestamp when created.
    pub created_at: i64,
    /// PDA bump seed.
    pub bump: u8,
}
