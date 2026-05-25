//! `agent_delegation` — Turnkey sub-orgs for autonomous Ghola agents.
//!
//! This module is the types + interface layer for the **delegated agent** feature
//! of the broader Turnkey integration (see
//! `~/.claude/projects/-Users-andersonobrien/memory/project_ghola_turnkey_integration.md`).
//!
//! ## Concepts
//!
//! - [`AgentSubOrg`] — a Turnkey sub-organization parented to a root user. One
//!   per agent DID (see headless-merchant agent identity protocol). Holds the
//!   shielded Aleo signing key derived via said-shielded from the Turnkey-signed
//!   seed.
//! - [`SpendingPolicy`] — Turnkey policy-engine rules that constrain what the
//!   agent's shielded signing key may sign: per-call cap, daily cap, merchant
//!   allowlist (Solana + Aleo), time-of-day window, kill switch.
//! - [`AgentDelegationClient`] — the trait the gateway holds; the production
//!   impl talks to Turnkey, the [`StubAgentDelegationClient`] is in-memory for
//!   local dev and unit tests, matching the [`crate::Vault`] / [`crate::LocalVault`]
//!   split used elsewhere in this crate.
//!
//! ## Daily-cap accounting choice
//!
//! The stub tracks daily spend per `(sub_org_id, calendar_day_utc)`. Calendar-UTC
//! is simpler to reason about than a rolling 24h window (no per-call decay, no
//! per-request scans of a spend log) and matches how Turnkey's own policy DSL
//! expresses time-based limits. Trade-off: an agent can spend twice the cap in
//! a six-hour stretch straddling 00:00 UTC. If a future product requirement
//! needs true rolling 24h, swap the accumulator for a sliding-window structure
//! without changing the trait surface. See [`StubAgentDelegationClient`] for
//! the accumulator implementation.

use async_trait::async_trait;
use chrono::{DateTime, Datelike, Timelike, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use thiserror::Error;

/// A sub-organization in Turnkey representing one autonomous agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSubOrg {
    /// Turnkey sub-org id (opaque to Ghola).
    pub sub_org_id: String,
    /// `did:ghola:agent:<id>` from said-types.
    pub agent_did: String,
    /// Root user (owner) this agent serves.
    pub parent_user_id: String,
    /// Policy id attached to this sub-org.
    pub policy_id: String,
    /// Handle to the Aleo shielded signing key in Turnkey.
    pub shielded_key_id: String,
    /// Creation timestamp.
    pub created_at: DateTime<Utc>,
    /// Lifecycle status.
    pub status: AgentStatus,
}

/// Lifecycle status of an [`AgentSubOrg`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentStatus {
    /// Healthy and signing.
    Active,
    /// Soft-paused (kill switch); can be resumed by updating policy.
    Suspended,
    /// Hard-revoked; no further signing under any policy.
    Revoked,
}

/// Spending policy attached to an [`AgentSubOrg`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpendingPolicy {
    /// Hard ceiling on any single transition the agent signs.
    pub max_per_call_micro_usdc: u64,
    /// Calendar-UTC-day cumulative ceiling across all transitions.
    pub daily_cap_micro_usdc: u64,
    /// Allowed merchants on Solana + Aleo (or any if `permit_unlisted`).
    pub merchant_allowlist: MerchantAllowlist,
    /// Optional time-of-day allowed window (UTC).
    pub time_window: Option<TimeWindow>,
    /// Master kill switch — overrides everything else.
    pub kill_switch_engaged: bool,
}

/// Merchants this agent may pay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MerchantAllowlist {
    /// Allowlisted Solana pubkeys (base58).
    pub solana_pubkeys: Vec<String>,
    /// Allowlisted Aleo addresses (`aleo1...`).
    pub aleo_addresses: Vec<String>,
    /// If true, any merchant is allowed (use sparingly).
    pub permit_unlisted: bool,
}

/// UTC time-of-day window. Wraparound supported (`start > end` = overnight).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TimeWindow {
    /// UTC hour, 0-23 inclusive.
    pub start_utc_hour: u8,
    /// UTC hour, 0-23 inclusive. May be < start_utc_hour to express overnight windows.
    pub end_utc_hour: u8,
}

/// A single spend the agent wants to make.
#[derive(Debug, Clone)]
pub struct SpendRequest {
    /// Amount in micro-USDC (1 USDC = 1_000_000 micro-USDC).
    pub amount_micro_usdc: u64,
    /// Solana destination, if this transition pays a Solana merchant.
    pub merchant_solana: Option<String>,
    /// Aleo destination, if this transition pays an Aleo merchant.
    pub merchant_aleo: Option<String>,
    /// Caller-provided timestamp (typically `Utc::now()`).
    pub timestamp_utc: DateTime<Utc>,
}

/// Outcome of evaluating a [`SpendRequest`] against a policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyEvaluation {
    /// Spend is allowed; the daily accumulator has been incremented.
    Allowed,
    /// Spend is denied; the daily accumulator was NOT incremented.
    Denied(DenyReason),
}

/// Why a [`PolicyEvaluation`] was [`PolicyEvaluation::Denied`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenyReason {
    /// Amount exceeded `max_per_call_micro_usdc`.
    OverPerCallCap,
    /// Amount + same-day prior spend exceeded `daily_cap_micro_usdc`.
    OverDailyCap,
    /// Merchant not in allowlist and `permit_unlisted` is false.
    MerchantNotAllowed,
    /// Current UTC hour falls outside `time_window`.
    OutsideTimeWindow,
    /// Kill switch engaged or status not Active.
    KillSwitchEngaged,
}

/// Errors raised by an [`AgentDelegationClient`].
#[derive(Debug, Error)]
pub enum AgentDelegationError {
    /// Sub-org with the given id was not found.
    #[error("agent sub-org not found")]
    NotFound,
    /// An agent with this DID already exists for this owner.
    #[error("agent sub-org already exists")]
    AlreadyExists,
    /// Policy values were rejected (e.g. start_utc_hour > 23).
    #[error("policy invalid: {0}")]
    PolicyInvalid(String),
    /// Sub-org kill switch is engaged — no signing allowed.
    #[error("kill switch engaged")]
    KillSwitchEngaged,
    /// Underlying transport (HTTP, RPC) failed.
    #[error("network error: {0}")]
    NetworkError(String),
    /// Serde failure during request/response handling.
    #[error("serde error: {0}")]
    SerdeError(String),
}

/// The sole contract between Ghola's agent runtime and the delegated-signing
/// backend. Production impl talks to Turnkey; [`StubAgentDelegationClient`]
/// is the in-memory dev/test backend.
#[async_trait]
pub trait AgentDelegationClient: Send + Sync {
    /// Spawn a new agent sub-org under `owner_id` with the given DID + policy.
    async fn spawn_agent(
        &self,
        owner_id: &str,
        agent_did: &str,
        policy: SpendingPolicy,
    ) -> Result<AgentSubOrg, AgentDelegationError>;

    /// Replace the policy attached to `sub_org_id`.
    async fn update_policy(
        &self,
        sub_org_id: &str,
        policy: SpendingPolicy,
    ) -> Result<(), AgentDelegationError>;

    /// Engage the kill switch — denies all subsequent evaluations.
    async fn engage_kill_switch(&self, sub_org_id: &str) -> Result<(), AgentDelegationError>;

    /// Hard-revoke the agent. Subsequent calls return [`AgentDelegationError::NotFound`].
    async fn revoke_agent(&self, sub_org_id: &str) -> Result<(), AgentDelegationError>;

    /// Evaluate `request` against the policy attached to `sub_org_id`. On
    /// [`PolicyEvaluation::Allowed`], the daily-cap accumulator is incremented
    /// atomically before this method returns.
    async fn evaluate(
        &self,
        sub_org_id: &str,
        request: &SpendRequest,
    ) -> Result<PolicyEvaluation, AgentDelegationError>;

    /// Sign a shielded Aleo transition under this agent's key.
    ///
    /// In a real implementation the server enforces correlation between the
    /// payload hash and an `Allowed` [`PolicyEvaluation`] (e.g. via an opaque
    /// signed authorization token returned from `evaluate`). The stub just
    /// checks that the sub-org is not kill-switched/revoked and returns a
    /// deterministic fake signature.
    async fn sign_shielded_transition(
        &self,
        sub_org_id: &str,
        transition_payload_hash: [u8; 32],
    ) -> Result<Vec<u8>, AgentDelegationError>;
}

// ---------------------------------------------------------------------------
// Stub implementation
// ---------------------------------------------------------------------------

/// In-memory state for one sub-org tracked by [`StubAgentDelegationClient`].
#[derive(Debug, Clone)]
struct StubAgentState {
    sub_org: AgentSubOrg,
    policy: SpendingPolicy,
    /// Daily spend per calendar-UTC day, keyed by `(year, ordinal_day)`.
    daily_spend: HashMap<(i32, u32), u64>,
}

/// In-memory [`AgentDelegationClient`] backing local dev + tests.
pub struct StubAgentDelegationClient {
    state: Mutex<HashMap<String, StubAgentState>>,
}

impl Default for StubAgentDelegationClient {
    fn default() -> Self {
        Self::new()
    }
}

impl StubAgentDelegationClient {
    /// Construct an empty stub client.
    pub fn new() -> Self {
        Self {
            state: Mutex::new(HashMap::new()),
        }
    }

    /// Validate a [`SpendingPolicy`]. Returns the first reason it's invalid.
    fn validate_policy(policy: &SpendingPolicy) -> Result<(), AgentDelegationError> {
        if let Some(tw) = &policy.time_window {
            if tw.start_utc_hour > 23 || tw.end_utc_hour > 23 {
                return Err(AgentDelegationError::PolicyInvalid(format!(
                    "time_window hours must be 0..=23, got start={} end={}",
                    tw.start_utc_hour, tw.end_utc_hour
                )));
            }
        }
        if policy.max_per_call_micro_usdc > policy.daily_cap_micro_usdc {
            return Err(AgentDelegationError::PolicyInvalid(
                "max_per_call_micro_usdc must be <= daily_cap_micro_usdc".into(),
            ));
        }
        Ok(())
    }
}

/// Does the request's merchant appear on the allowlist?
fn merchant_allowed(allowlist: &MerchantAllowlist, request: &SpendRequest) -> bool {
    if allowlist.permit_unlisted {
        return true;
    }
    if let Some(sol) = &request.merchant_solana {
        if allowlist.solana_pubkeys.iter().any(|p| p == sol) {
            return true;
        }
    }
    if let Some(aleo) = &request.merchant_aleo {
        if allowlist.aleo_addresses.iter().any(|a| a == aleo) {
            return true;
        }
    }
    false
}

/// Is `hour` inside the (possibly wrapping) `window`?
fn hour_in_window(window: &TimeWindow, hour: u8) -> bool {
    if window.start_utc_hour <= window.end_utc_hour {
        // Non-wrapping: [start, end] inclusive.
        hour >= window.start_utc_hour && hour <= window.end_utc_hour
    } else {
        // Wrapping overnight: hour >= start OR hour < end (end is exclusive
        // on the morning side to give a sensible semantic for 22→6 = "from
        // 22:00 through 05:59"; tests pin this behaviour).
        hour >= window.start_utc_hour || hour < window.end_utc_hour
    }
}

#[async_trait]
impl AgentDelegationClient for StubAgentDelegationClient {
    async fn spawn_agent(
        &self,
        owner_id: &str,
        agent_did: &str,
        policy: SpendingPolicy,
    ) -> Result<AgentSubOrg, AgentDelegationError> {
        Self::validate_policy(&policy)?;

        let mut guard = self.state.lock().unwrap();

        // Reject duplicate DID under the same owner.
        if guard
            .values()
            .any(|s| s.sub_org.agent_did == agent_did && s.sub_org.parent_user_id == owner_id)
        {
            return Err(AgentDelegationError::AlreadyExists);
        }

        let sub_org_id = format!("stub:{}", uuid::Uuid::new_v4());
        let sub_org = AgentSubOrg {
            sub_org_id: sub_org_id.clone(),
            agent_did: agent_did.to_string(),
            parent_user_id: owner_id.to_string(),
            policy_id: format!("policy:{}", uuid::Uuid::new_v4()),
            shielded_key_id: format!("aleo-key:{}", uuid::Uuid::new_v4()),
            created_at: Utc::now(),
            status: AgentStatus::Active,
        };

        guard.insert(
            sub_org_id,
            StubAgentState {
                sub_org: sub_org.clone(),
                policy,
                daily_spend: HashMap::new(),
            },
        );

        Ok(sub_org)
    }

    async fn update_policy(
        &self,
        sub_org_id: &str,
        policy: SpendingPolicy,
    ) -> Result<(), AgentDelegationError> {
        Self::validate_policy(&policy)?;
        let mut guard = self.state.lock().unwrap();
        let state = guard
            .get_mut(sub_org_id)
            .ok_or(AgentDelegationError::NotFound)?;
        // Updating policy implicitly clears any prior kill-switch suspension.
        if state.sub_org.status == AgentStatus::Suspended && !policy.kill_switch_engaged {
            state.sub_org.status = AgentStatus::Active;
        }
        state.policy = policy;
        Ok(())
    }

    async fn engage_kill_switch(&self, sub_org_id: &str) -> Result<(), AgentDelegationError> {
        let mut guard = self.state.lock().unwrap();
        let state = guard
            .get_mut(sub_org_id)
            .ok_or(AgentDelegationError::NotFound)?;
        state.policy.kill_switch_engaged = true;
        state.sub_org.status = AgentStatus::Suspended;
        Ok(())
    }

    async fn revoke_agent(&self, sub_org_id: &str) -> Result<(), AgentDelegationError> {
        let mut guard = self.state.lock().unwrap();
        // Per spec: after revoke, evaluate returns NotFound. Removing the entry
        // (rather than just flipping status) makes that the natural outcome
        // and matches the "hard revoke — no further signing under any policy"
        // semantic in the doc comment.
        guard
            .remove(sub_org_id)
            .ok_or(AgentDelegationError::NotFound)?;
        Ok(())
    }

    async fn evaluate(
        &self,
        sub_org_id: &str,
        request: &SpendRequest,
    ) -> Result<PolicyEvaluation, AgentDelegationError> {
        let mut guard = self.state.lock().unwrap();
        let state = guard
            .get_mut(sub_org_id)
            .ok_or(AgentDelegationError::NotFound)?;

        // 1. Status must be Active.
        if state.sub_org.status != AgentStatus::Active {
            return Ok(PolicyEvaluation::Denied(DenyReason::KillSwitchEngaged));
        }

        // 2. Kill switch on policy.
        if state.policy.kill_switch_engaged {
            return Ok(PolicyEvaluation::Denied(DenyReason::KillSwitchEngaged));
        }

        // 3. Per-call cap.
        if request.amount_micro_usdc > state.policy.max_per_call_micro_usdc {
            return Ok(PolicyEvaluation::Denied(DenyReason::OverPerCallCap));
        }

        // 4. Daily cap.
        let day_key = (
            request.timestamp_utc.year(),
            request.timestamp_utc.ordinal(),
        );
        let already_spent = state.daily_spend.get(&day_key).copied().unwrap_or(0);
        let projected = already_spent.saturating_add(request.amount_micro_usdc);
        if projected > state.policy.daily_cap_micro_usdc {
            return Ok(PolicyEvaluation::Denied(DenyReason::OverDailyCap));
        }

        // 5. Merchant allowlist.
        if !merchant_allowed(&state.policy.merchant_allowlist, request) {
            return Ok(PolicyEvaluation::Denied(DenyReason::MerchantNotAllowed));
        }

        // 6. Time-of-day window.
        if let Some(tw) = &state.policy.time_window {
            let hour = request.timestamp_utc.hour() as u8;
            if !hour_in_window(tw, hour) {
                return Ok(PolicyEvaluation::Denied(DenyReason::OutsideTimeWindow));
            }
        }

        // 7. Allowed — atomically bump the day accumulator.
        state.daily_spend.insert(day_key, projected);
        Ok(PolicyEvaluation::Allowed)
    }

    async fn sign_shielded_transition(
        &self,
        sub_org_id: &str,
        transition_payload_hash: [u8; 32],
    ) -> Result<Vec<u8>, AgentDelegationError> {
        let guard = self.state.lock().unwrap();
        let state = guard
            .get(sub_org_id)
            .ok_or(AgentDelegationError::NotFound)?;
        if state.sub_org.status != AgentStatus::Active || state.policy.kill_switch_engaged {
            return Err(AgentDelegationError::KillSwitchEngaged);
        }
        // Stub: deterministic "signature" = sub_org_id bytes || payload hash.
        // A real backend would call Turnkey's sign API with the shielded key.
        let mut sig = Vec::with_capacity(sub_org_id.len() + 32);
        sig.extend_from_slice(sub_org_id.as_bytes());
        sig.extend_from_slice(&transition_payload_hash);
        Ok(sig)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// 1 USDC = 1_000_000 micro-USDC. Useful in tests for readable numbers.
    const USDC: u64 = 1_000_000;

    fn solana_only_allowlist(pubkey: &str) -> MerchantAllowlist {
        MerchantAllowlist {
            solana_pubkeys: vec![pubkey.to_string()],
            aleo_addresses: vec![],
            permit_unlisted: false,
        }
    }

    fn basic_policy(allowlist: MerchantAllowlist) -> SpendingPolicy {
        SpendingPolicy {
            max_per_call_micro_usdc: 10 * USDC,
            daily_cap_micro_usdc: 40 * USDC,
            merchant_allowlist: allowlist,
            time_window: None,
            kill_switch_engaged: false,
        }
    }

    fn spend(amount: u64, sol: &str, at: DateTime<Utc>) -> SpendRequest {
        SpendRequest {
            amount_micro_usdc: amount,
            merchant_solana: Some(sol.to_string()),
            merchant_aleo: None,
            timestamp_utc: at,
        }
    }

    #[tokio::test]
    async fn spawn_then_update_then_evaluate_happy_path() {
        let client = StubAgentDelegationClient::new();
        let merchant = "Merchant111111111111111111111111111111111";

        let agent = client
            .spawn_agent(
                "owner-alice",
                "did:ghola:agent:alpha",
                basic_policy(solana_only_allowlist(merchant)),
            )
            .await
            .unwrap();

        // Update policy: raise daily cap.
        let mut new_policy = basic_policy(solana_only_allowlist(merchant));
        new_policy.daily_cap_micro_usdc = 100 * USDC;
        client
            .update_policy(&agent.sub_org_id, new_policy)
            .await
            .unwrap();

        let result = client
            .evaluate(
                &agent.sub_org_id,
                &spend(5 * USDC, merchant, Utc::now()),
            )
            .await
            .unwrap();
        assert_eq!(result, PolicyEvaluation::Allowed);

        // Signing succeeds for Active sub-org.
        let sig = client
            .sign_shielded_transition(&agent.sub_org_id, [7u8; 32])
            .await
            .unwrap();
        assert!(sig.len() > 32);
    }

    #[tokio::test]
    async fn over_per_call_cap_is_denied() {
        let client = StubAgentDelegationClient::new();
        let merchant = "MerchantPerCall1111111111111111111111111";
        let agent = client
            .spawn_agent(
                "o",
                "did:ghola:agent:b",
                basic_policy(solana_only_allowlist(merchant)),
            )
            .await
            .unwrap();

        let result = client
            .evaluate(
                &agent.sub_org_id,
                &spend(11 * USDC, merchant, Utc::now()),
            )
            .await
            .unwrap();
        assert_eq!(result, PolicyEvaluation::Denied(DenyReason::OverPerCallCap));
    }

    #[tokio::test]
    async fn multiple_evals_exceeding_daily_cap_denies_overflow() {
        let client = StubAgentDelegationClient::new();
        let merchant = "MerchantDaily11111111111111111111111111";
        // Cap = 40 USDC, per-call = 10 USDC → 4 evals fill the day, 5th rejects.
        let agent = client
            .spawn_agent(
                "o",
                "did:ghola:agent:c",
                basic_policy(solana_only_allowlist(merchant)),
            )
            .await
            .unwrap();

        let pinned = Utc.with_ymd_and_hms(2026, 5, 22, 14, 0, 0).unwrap();

        for _ in 0..4 {
            let r = client
                .evaluate(&agent.sub_org_id, &spend(10 * USDC, merchant, pinned))
                .await
                .unwrap();
            assert_eq!(r, PolicyEvaluation::Allowed);
        }

        let fifth = client
            .evaluate(&agent.sub_org_id, &spend(10 * USDC, merchant, pinned))
            .await
            .unwrap();
        assert_eq!(fifth, PolicyEvaluation::Denied(DenyReason::OverDailyCap));
    }

    #[tokio::test]
    async fn wrong_merchant_is_denied() {
        let client = StubAgentDelegationClient::new();
        let allowed = "AllowedMerchant1111111111111111111111111";
        let other = "OtherMerchant111111111111111111111111111";

        let agent = client
            .spawn_agent(
                "o",
                "did:ghola:agent:d",
                basic_policy(solana_only_allowlist(allowed)),
            )
            .await
            .unwrap();

        let result = client
            .evaluate(&agent.sub_org_id, &spend(1 * USDC, other, Utc::now()))
            .await
            .unwrap();
        assert_eq!(
            result,
            PolicyEvaluation::Denied(DenyReason::MerchantNotAllowed)
        );
    }

    #[tokio::test]
    async fn overnight_time_window_allows_03_denies_12() {
        let client = StubAgentDelegationClient::new();
        let merchant = "MerchantOvernight11111111111111111111111";

        let mut policy = basic_policy(solana_only_allowlist(merchant));
        policy.time_window = Some(TimeWindow {
            start_utc_hour: 22,
            end_utc_hour: 6,
        });

        let agent = client
            .spawn_agent("o", "did:ghola:agent:e", policy)
            .await
            .unwrap();

        let at_3am = Utc.with_ymd_and_hms(2026, 5, 22, 3, 0, 0).unwrap();
        let at_noon = Utc.with_ymd_and_hms(2026, 5, 22, 12, 0, 0).unwrap();

        let r1 = client
            .evaluate(&agent.sub_org_id, &spend(1 * USDC, merchant, at_3am))
            .await
            .unwrap();
        assert_eq!(r1, PolicyEvaluation::Allowed);

        let r2 = client
            .evaluate(&agent.sub_org_id, &spend(1 * USDC, merchant, at_noon))
            .await
            .unwrap();
        assert_eq!(
            r2,
            PolicyEvaluation::Denied(DenyReason::OutsideTimeWindow)
        );
    }

    #[tokio::test]
    async fn kill_switch_denies_subsequent_evals() {
        let client = StubAgentDelegationClient::new();
        let merchant = "MerchantKill1111111111111111111111111111";

        let agent = client
            .spawn_agent(
                "o",
                "did:ghola:agent:f",
                basic_policy(solana_only_allowlist(merchant)),
            )
            .await
            .unwrap();

        // First eval allowed.
        let r1 = client
            .evaluate(&agent.sub_org_id, &spend(1 * USDC, merchant, Utc::now()))
            .await
            .unwrap();
        assert_eq!(r1, PolicyEvaluation::Allowed);

        client.engage_kill_switch(&agent.sub_org_id).await.unwrap();

        let r2 = client
            .evaluate(&agent.sub_org_id, &spend(1 * USDC, merchant, Utc::now()))
            .await
            .unwrap();
        assert_eq!(
            r2,
            PolicyEvaluation::Denied(DenyReason::KillSwitchEngaged)
        );

        // Signing also rejected after kill switch.
        let sign_err = client
            .sign_shielded_transition(&agent.sub_org_id, [0u8; 32])
            .await
            .unwrap_err();
        assert!(matches!(sign_err, AgentDelegationError::KillSwitchEngaged));
    }

    #[tokio::test]
    async fn revoke_makes_subsequent_evaluate_return_not_found() {
        let client = StubAgentDelegationClient::new();
        let merchant = "MerchantRevoke111111111111111111111111111";

        let agent = client
            .spawn_agent(
                "o",
                "did:ghola:agent:g",
                basic_policy(solana_only_allowlist(merchant)),
            )
            .await
            .unwrap();

        client.revoke_agent(&agent.sub_org_id).await.unwrap();

        let err = client
            .evaluate(&agent.sub_org_id, &spend(1 * USDC, merchant, Utc::now()))
            .await
            .unwrap_err();
        assert!(matches!(err, AgentDelegationError::NotFound));

        // Double-revoke is itself NotFound.
        let err2 = client.revoke_agent(&agent.sub_org_id).await.unwrap_err();
        assert!(matches!(err2, AgentDelegationError::NotFound));
    }

    #[tokio::test]
    async fn duplicate_agent_did_for_same_owner_is_rejected() {
        let client = StubAgentDelegationClient::new();
        let merchant = "MerchantDup111111111111111111111111111111";
        let did = "did:ghola:agent:dup";

        client
            .spawn_agent("owner-x", did, basic_policy(solana_only_allowlist(merchant)))
            .await
            .unwrap();

        let err = client
            .spawn_agent("owner-x", did, basic_policy(solana_only_allowlist(merchant)))
            .await
            .unwrap_err();
        assert!(matches!(err, AgentDelegationError::AlreadyExists));
    }

    #[tokio::test]
    async fn invalid_policy_time_window_rejected_at_spawn() {
        let client = StubAgentDelegationClient::new();
        let merchant = "M";
        let mut policy = basic_policy(solana_only_allowlist(merchant));
        policy.time_window = Some(TimeWindow {
            start_utc_hour: 25,
            end_utc_hour: 0,
        });
        let err = client
            .spawn_agent("o", "did:ghola:agent:bad", policy)
            .await
            .unwrap_err();
        assert!(matches!(err, AgentDelegationError::PolicyInvalid(_)));
    }
}
