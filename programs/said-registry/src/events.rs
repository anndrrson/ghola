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
