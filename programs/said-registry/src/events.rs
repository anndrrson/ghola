use anchor_lang::prelude::*;

#[event]
pub struct IdentityRegistered {
    pub master_pubkey: [u8; 32],
    pub did_key: String,
    pub authority: Pubkey,
}

#[event]
pub struct IdentityDeactivated {
    pub master_pubkey: [u8; 32],
}

#[event]
pub struct IdentityReactivated {
    pub master_pubkey: [u8; 32],
}

#[event]
pub struct AuthorityUpdated {
    pub master_pubkey: [u8; 32],
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct ServiceRegistered {
    pub identity_record: Pubkey,
    pub slug: String,
    pub base_url: String,
    pub authority: Pubkey,
}

#[event]
pub struct ServiceDeactivated {
    pub identity_record: Pubkey,
    pub slug: String,
}

#[event]
pub struct ReputationAttested {
    pub entity: Pubkey,
    pub overall_score: u16,
    pub confidence: u16,
    pub total_transactions: u32,
}
