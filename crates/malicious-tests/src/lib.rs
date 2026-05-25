//! Malicious-actor scenario suite for the Ghola shielded pool.
//!
//! Stream 9 of the production-hardening pass. The other streams add the
//! defenses (invariants, dedup, retries, log redaction, decoy
//! indistinguishability, governance timelocks); this crate provides the
//! *adversarial* viewpoint — for each named attacker profile, we describe
//! the capability, simulate the attack against the off-chain code paths
//! we own, and assert that the corresponding mitigation actually trips.
//!
//! See `docs/shielded-pool/THREAT_SCENARIOS.md` for the prose runbook
//! (capability, defense citations, residual risk, detect-and-respond)
//! that mirrors the test layout here.
//!
//! # Layout
//!
//! Each attacker profile lives in its own module under [`actors`] and
//! its tests live in a sibling `tests/malicious_<actor>.rs` integration
//! test file. The module here exposes the helper types / mock
//! submitters / log-capture utilities the integration test consumes.
//!
//! # Online vs offline tests
//!
//! All `#[tokio::test]`s in this crate run OFFLINE against
//! `chaos_tests::harness::TestRelayer` and `wiremock`-backed RPC. Any
//! test that requires the deployed on-chain program is gated with
//! `#[ignore]` and re-enabled by the dispatcher post-redeploy.

#![forbid(unsafe_code)]

pub mod actors;
pub mod log_capture;
pub mod mock_submit;
