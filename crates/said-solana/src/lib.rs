pub mod client;
pub mod error;
pub mod instructions;
pub mod pda;
pub mod tx;

pub use client::{IdentityRecord, SolanaClient};
pub use error::{Result, SolanaError};
pub use instructions::{build_register_message, build_update_profile_uri_ix};
pub use pda::{find_identity_pda, PROGRAM_ID_B58};
