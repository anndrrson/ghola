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
