//! Attacker-profile catalogue.
//!
//! Each variant of [`Profile`] names one section of
//! `docs/shielded-pool/THREAT_SCENARIOS.md` and one integration-test
//! file under `tests/`. The enum exists mainly so a generic
//! "what-am-I-testing" log line can name the profile uniformly across
//! the suite.

/// Distinct attacker profiles modelled by the suite.
///
/// The numbering matches the section order in
/// `docs/shielded-pool/THREAT_SCENARIOS.md` so a test author scanning
/// for the right section by name can grep one place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    /// A relayer that drops, reorders, delays, or correlates the txs
    /// it brokers. Tested in `tests/malicious_relayer.rs`.
    MaliciousRelayer,
    /// A forester signer that submits stale roots, garbage proofs,
    /// out-of-order batches, or censors specific commits. Tested in
    /// `tests/malicious_forester.rs`.
    MaliciousForester,
    /// A TEE worker that leaks queue order or timing.
    MaliciousWorker,
    /// A compromised prover that tries to leak witnesses to logs or
    /// disk. Tested in `tests/malicious_prover.rs`.
    MaliciousProver,
    /// A malicious app that floods the relayer with garbage proofs
    /// or proofs against stale roots. Tested in `tests/malicious_app.rs`.
    MaliciousApp,
    /// A compromised admin keypair that tries to push instant VK
    /// rotations or admin handovers. Tested in
    /// `tests/malicious_governance.rs`.
    MaliciousGovernance,
    /// A spamming user inflating queue depth or burning queue slots
    /// with dust deposits. Tested in `tests/malicious_griefing.rs`.
    Griefing,
}

impl Profile {
    /// Short human-readable label used in `tracing::info!` lines so a
    /// test failure's log neighbourhood names the actor.
    pub const fn label(&self) -> &'static str {
        match self {
            Profile::MaliciousRelayer => "malicious-relayer",
            Profile::MaliciousForester => "malicious-forester",
            Profile::MaliciousWorker => "malicious-worker",
            Profile::MaliciousProver => "malicious-prover",
            Profile::MaliciousApp => "malicious-app",
            Profile::MaliciousGovernance => "malicious-governance",
            Profile::Griefing => "griefing",
        }
    }
}
