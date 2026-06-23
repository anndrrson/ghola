import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import {
  buildFrontRunCertificate,
  deriveFrontRunProtection,
  type FrontRunMode,
  type FrontRunProtection,
} from "./private-account-front-run-protection";

export const PRIVATE_ACCOUNT_VERSION = 1;
export const PRIVATE_ACCOUNT_INTENT_TTL_MS = 30 * 60 * 1000;
export const PRIVATE_ACCOUNT_PREVIEW_TTL_MS = 10 * 60 * 1000;

export type GholaThreatActor =
  | "public_chain_observer"
  | "rpc_provider"
  | "wallet_provider"
  | "relayer"
  | "external_platform"
  | "solver_or_counterparty"
  | "ghola_operator"
  | "timing_observer"
  | "colluding_platforms";

export type GholaAnonymityLevel =
  | "P0_public"
  | "P1_source_hidden"
  | "P2_bucketed"
  | "P3_anonymity_set"
  | "P4_operator_blind"
  | "P5_selectively_disclosable";

export type GholaClaimStatus =
  | "private_mode_available"
  | "full_anonymity_available"
  | "wait_for_anonymity"
  | "degraded_user_accepted_required"
  | "blocked_leaky_path";

export type GholaPlatformClass =
  | "solana_public_wallet"
  | "solana_private_balance"
  | "solana_perps_market"
  | "solana_swap_aggregator"
  | "hyperliquid_style_market"
  | "coinbase_style_provider"
  | "rfq_solver_network"
  | "partner_tokenized_assets";

export type GholaRailKind =
  | "private_state_only"
  | "vault_omnibus_netting"
  | "combined_vault_shielded_batch"
  | "shielded_batch_auction"
  | "shielded_pool"
  | "confidential_token"
  | "provider_omnibus_subaccount"
  | "private_relayer"
  | "stealth_change_address"
  | "direct_public_fallback";

export type GholaPrivateAccountActionClass =
  | "pay"
  | "transfer"
  | "fund_platform"
  | "trade_on_platform"
  | "rebalance"
  | "maintain_allocation"
  | "withdraw";

export const GHOLA_FUNDING_AMOUNT_BUCKETS = ["5", "10", "25", "50", "100"] as const;

export type GholaFundingAmountBucket = (typeof GHOLA_FUNDING_AMOUNT_BUCKETS)[number];

export function isFundingAmountBucket(value: string): value is GholaFundingAmountBucket {
  return (GHOLA_FUNDING_AMOUNT_BUCKETS as readonly string[]).includes(value);
}

export type GholaLeakageStatus =
  | "hidden_by_private_account"
  | "hidden_by_vault_netting"
  | "hidden_by_shielded_pool"
  | "minimized_by_bucket"
  | "visible_to_platform"
  | "visible_to_counterparty"
  | "visible_on_public_chain"
  | "blocked_by_policy"
  | "degraded_user_accepted";

export interface GholaThreatModel {
  version: 1;
  private_against: GholaThreatActor[];
  partially_private_against: GholaThreatActor[];
  not_private_against: GholaThreatActor[];
}

export interface GholaAnonymitySetPolicy {
  version: 1;
  consumer_min_effective_set: number;
  institutional_min_effective_set: number;
  rfq_min_solver_count: number;
  amount_bucket_micro_usd: number[];
  min_delay_seconds: number;
}

export interface GholaAnonymitySetSummary {
  required: number;
  effective: number;
  solver_count?: number;
  amount_bucketed: boolean;
  timing_window_met: boolean;
  uniqueness_score_bps: number;
  repeated_pattern_score_bps: number;
}

export interface GholaPrivacyBudget {
  version: 1;
  degraded_action_count: number;
  repeated_withdrawal_count: number;
  repeated_cadence_count: number;
  platform_concentration_bps: number;
  solver_concentration_bps: number;
}

export type GholaPrivateModeEvidenceStatus =
  | "none"
  | "missing"
  | "ready"
  | "stale"
  | "unhealthy";

export interface GholaPrivateModeEvidenceChain {
  version: 1;
  funding_import_commitment: string | null;
  batch_id: string | null;
  batch_evidence_commitment: string | null;
  preview_commitment: string;
  manifest_commitment?: string | null;
  connector_readiness_commitment?: string | null;
  compiler_commitment?: string | null;
  linkability_score_commitment?: string | null;
  work_order_commitment?: string | null;
  connector_result_commitment?: string | null;
  platform_fee_policy_commitment?: string | null;
  execution_plan_commitment?: string | null;
  approval_commitment: string | null;
  execution_commitment: string | null;
  settlement_commitment?: string | null;
  auction_epoch_commitment?: string | null;
  auction_order_commitment?: string | null;
  clearing_commitment?: string | null;
  auction_settlement_commitment?: string | null;
  root_commitment?: string | null;
  witness_commitment?: string | null;
  proof_commitment?: string | null;
  relay_commitment?: string | null;
  finality_commitment?: string | null;
  attestation_commitment?: string | null;
  runtime_envelope_commitment?: string | null;
  runtime_attestation_commitment?: string | null;
  runtime_health_commitment?: string | null;
  schedule_commitment?: string | null;
  rotation_commitment?: string | null;
  simulator_commitment?: string | null;
  front_run_certificate_commitment?: string | null;
}

export interface GholaPlatformPrivacyProfile {
  version: 1;
  platform_class: GholaPlatformClass;
  label: string;
  supported_products: GholaPrivateAccountActionClass[];
  public_chain_sees: "hidden" | "bucketed" | "visible" | "blocked";
  platform_sees: "none" | "minimal" | "order_visible" | "account_visible";
  ghola_operator_sees: "commitment_only" | "sealed_runtime" | "runtime_visible";
  counterparty_sees: "none" | "ticket_only" | "selected_quote_only" | "order_visible";
  privacy_runnable_rails: GholaRailKind[];
  degraded_conditions: string[];
  blocked_conditions: string[];
  connector_readiness_commitment: string;
}

export interface GholaConnectorPreviewContext {
  version: 1;
  manifest_commitment: string;
  connector_readiness_commitment: string;
  compiler_commitment: string;
  linkability_score_commitment: string;
  sandbox_policy_commitment: string;
  connector_status: "ready" | "missing" | "stale" | "blocked";
  linkability_decision:
    | "proceed"
    | "degraded_acceptance_required"
    | "wait_for_batch"
    | "rotate_or_block"
    | "blocked";
  main_wallet_exposed: boolean;
  venue_order_visibility: "hidden" | "ticket_only" | "order_visible" | "account_visible";
  public_chain_settlement_visibility: "hidden" | "bucketed" | "visible" | "blocked";
  venue_access_source:
    | "none"
    | "user_provided_credentials"
    | "ghola_managed_testnet"
    | "ghola_pooled_venue_account"
    | "hyperliquid_native_vault"
    | "partner_omnibus";
  ghola_access_role: "private_execution_router" | "private_state_operator" | "connector_only";
  venue_gate: "not_applicable" | "venue_accepts_or_rejects_credentials" | "partner_accepts_or_rejects_order";
  venue_visibility: "none" | "ticket_only" | "execution_account_and_order_activity" | "provider_account_and_order_activity";
  source_wallet_visibility: "not_exposed_to_public_chain_by_ghola" | "visible_on_public_chain" | "not_applicable";
  privacy_claim: "private_mode_available" | "venue_visible_order_degraded" | "public_chain_visible_degraded";
  reason_codes: string[];
}

export type GholaPrivateModeClaimLevel =
  | "source_wallet_hidden"
  | "amount_bucketed"
  | "batched_anonymity_set"
  | "operator_sealed"
  | "selectively_disclosable";

export interface GholaSealedRuntimeContext {
  version: 1;
  runtime_status: "ready" | "missing" | "stale" | "unhealthy";
  runtime_mode: "http" | "local_test";
  runtime_envelope_commitment: string;
  runtime_attestation_commitment: string | null;
  runtime_measurement_commitment: string | null;
  runtime_policy_commitment: string | null;
  runtime_health_commitment: string;
  runtime_observed_at: string;
  reason_codes: string[];
}

export interface GholaPrivacyScheduleDecision {
  version: 1;
  schedule_commitment: string;
  mode: "scheduled_private_window" | "immediate_degraded" | "ready_now";
  status: "ready" | "waiting" | "degraded" | "blocked";
  privacy_window_commitment: string;
  execute_after: string | null;
  reason_codes: string[];
}

export interface GholaPlatformFundingRotation {
  version: 1;
  rotation_commitment: string;
  platform_funding_account_commitment: string;
  rotation_epoch_commitment: string;
  reuse_count: number;
  withdrawal_destination_reuse_count: number;
  status: "ready" | "rotate_required" | "blocked";
  reason_codes: string[];
}

export interface GholaAdversarialLinkabilitySimulation {
  version: 1;
  simulator_commitment: string;
  score_bps: number;
  decision: "proceed" | "wait_for_batch" | "rotate" | "degraded_acceptance_required" | "blocked";
  actors: Record<
    | "chain_observer"
    | "venue"
    | "solver"
    | "provider"
    | "colluding_platforms",
    number
  >;
  reason_codes: string[];
  simulated_at: string;
}

export interface GholaPrivateExecutionAccount {
  version: 1;
  account_commitment: string;
  session_commitment: string;
  turnkey_wallet_commitment: string;
  vault_root_commitment: string;
  policy_commitment: string;
  platform_link_root: string;
  privacy_mode: "private_mode" | "full_anonymity";
  claim_boundary: "engine_gated_full_anonymity";
  vault_ready: boolean;
}

export type GholaEncryptedBundleAlg =
  | "sealed-provider-v1"
  | "hpke-x25519-aes256gcm";

export interface GholaEncryptedPrivateBundle {
  version: 1;
  alg: GholaEncryptedBundleAlg;
  ciphertext: string;
  ciphertext_commitment: string;
  recipient: string;
  recipient_commitment: string;
  aad: string;
  aad_commitment: string;
  encapsulated_key_commitment: string | null;
}

export type GholaVenueId =
  | "hyperliquid"
  | "phoenix"
  | "drift"
  | "jupiter"
  | "backpack"
  | "coinbase_advanced"
  | "rfq_network";

export type GholaVenueAccountMode =
  | "byo_account"
  | "user_stealth"
  | "ghola_pooled";

export type GholaVenueExecutionMode =
  | "byo_api_key"
  | "user_stealth"
  | "ghola_pooled"
  | "partner_omnibus"
  | "managed_testnet"
  | "hyperliquid_native_vault";

export type GholaVenueOperationClass =
  | "read"
  | "preview_order"
  | "limit_order"
  | "perp_limit_order"
  | "spot_limit_order"
  | "spot_market_order"
  | "swap"
  | "cancel"
  | "fills"
  | "reconcile";

export type GholaVenueBlockedOperation =
  | "withdraw"
  | "vault_transfer"
  | "leverage_escalation"
  | "margin"
  | "futures"
  | "staking"
  | "portfolio_mutation"
  | "raw_custody_transfer";

export interface GholaVenueExecutionVault {
  version: 1;
  venue_id: GholaVenueId;
  platform_class: GholaPlatformClass;
  execution_mode: GholaVenueExecutionMode;
  account_mode: GholaVenueAccountMode;
  account_commitment: string;
  vault_commitment: string;
  encrypted_vault_commitment: string;
  recipient_commitment: string;
  policy_commitment: string;
  allocation_commitment: string | null;
  encrypted_execution_vault: GholaEncryptedPrivateBundle;
  supported_operations: GholaVenueOperationClass[];
  blocked_operations: GholaVenueBlockedOperation[];
  status: "sealed" | "stale" | "revoked";
  created_at: string;
  updated_at: string;
}

export interface GholaVenueManifest {
  version: 1;
  venue_id: GholaVenueId;
  platform_class: GholaPlatformClass;
  label: string;
  supported_account_modes: GholaVenueAccountMode[];
  default_account_mode: GholaVenueAccountMode;
  supported_actions: GholaPrivateAccountActionClass[];
  supported_operations: GholaVenueOperationClass[];
  supported_rails: GholaRailKind[];
  main_wallet_hidden_modes: GholaVenueAccountMode[];
  venue_account_hidden_modes: GholaVenueAccountMode[];
  venue_sees: "none" | "stealth_account_and_order" | "pooled_account_and_order" | "user_account_and_order";
  public_chain_sees: "hidden" | "bucketed" | "visible" | "blocked";
  minimum_anonymity_set: number;
  pilot_max_notional_bucket: "5" | "10" | "25" | "50" | "100";
  blocked_operations: GholaVenueBlockedOperation[];
  manifest_commitment: string;
  expires_at: string;
}

export interface GholaSecretHandle {
  version: 1;
  secret_handle_commitment: string;
  owner_commitment: string;
  account_commitment: string;
  venue_id: GholaVenueId;
  platform_class: GholaPlatformClass;
  account_mode: GholaVenueAccountMode;
  purpose: "venue_account" | "venue_api_key" | "trader_authority" | "pooled_operator";
  sealed_runtime_recipient_commitment: string;
  encrypted_secret_commitment: string;
  policy_commitment: string;
  rotation_epoch: number;
  status: "sealed" | "rotated" | "revoked";
  created_at: string;
  updated_at: string;
}

export interface GholaStealthVenueAccount {
  version: 1;
  venue_account_commitment: string;
  venue_id: GholaVenueId;
  platform_class: GholaPlatformClass;
  account_mode: "user_stealth";
  account_commitment: string;
  secret_handle_commitment: string;
  funding_evidence_commitment: string | null;
  rotation_epoch_commitment: string;
  main_wallet_exposed: false;
  venue_account_visible_to_venue: true;
  status: "created" | "funding_required" | "ready" | "rotated" | "revoked";
  created_at: string;
  updated_at: string;
}

export interface GholaPooledVenueAllocation {
  version: 1;
  pooled_allocation_commitment: string;
  venue_id: GholaVenueId;
  platform_class: GholaPlatformClass;
  account_mode: "ghola_pooled";
  account_commitment: string;
  pool_commitment: string;
  pool_share_commitment: string;
  subledger_account_commitment: string;
  eligibility_commitment: string | null;
  funding_evidence_commitment: string | null;
  settlement_evidence_commitment: string | null;
  utilization_bucket: "0" | "5" | "10" | "25" | "50" | "100";
  main_wallet_exposed: false;
  venue_account_visible_to_venue: false;
  status: "allocated" | "pending_funding" | "paused" | "revoked";
  created_at: string;
  updated_at: string;
}

export interface GholaVenueEligibilityCredential {
  version: 1;
  eligibility_commitment: string;
  owner_commitment: string;
  account_commitment: string;
  venue_id: GholaVenueId;
  platform_class: GholaPlatformClass;
  credential_type: "self_attested_eligible_user" | "partner_verified_eligible_user";
  credential_scope: "eligible_venue_access_only";
  status: "verified" | "revoked" | "expired";
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface GholaVenueSessionPolicy {
  version: 1;
  venue_id: GholaVenueId;
  execution_mode: GholaVenueExecutionMode;
  policy_commitment: string;
  market_allowlist: string[];
  max_notional_bucket: "5" | "10" | "25" | "50" | "100";
  max_order_count: number;
  expires_at: string;
  kill_switch: boolean;
  allowed_operations: GholaVenueOperationClass[];
  blocked_operations: GholaVenueBlockedOperation[];
  strategy_commitment: string;
  prompt_commitment: string;
  created_at: string;
}

export interface GholaOmnibusAllocation {
  version: 1;
  venue_id: "coinbase_advanced";
  platform_class: "coinbase_style_provider";
  execution_mode: "partner_omnibus";
  account_commitment: string;
  pool_commitment: string;
  partner_commitment: string;
  subledger_account_commitment: string;
  allocation_commitment: string;
  settlement_funding_commitment: string | null;
  utilization_bucket: "0" | "5" | "10" | "25" | "50" | "100";
  status: "allocated" | "pending_funding" | "paused" | "revoked";
  supported_operations: GholaVenueOperationClass[];
  blocked_operations: GholaVenueBlockedOperation[];
  created_at: string;
  updated_at: string;
}

export interface GholaHyperliquidManagedAllocation {
  version: 1;
  venue_id: "hyperliquid";
  platform_class: "hyperliquid_style_market";
  execution_mode: "managed_testnet" | "ghola_pooled" | "hyperliquid_native_vault";
  network: "testnet" | "mainnet";
  account_commitment: string;
  allocation_commitment: string;
  policy_commitment: string;
  pool_commitment: string;
  pool_share_commitment?: string;
  subledger_account_commitment: string;
  vault_address?: string | null;
  vault_controller_address?: string | null;
  agent_wallet_commitment?: string | null;
  deposit_evidence_commitment?: string | null;
  deposit_status?: "unfunded" | "pending" | "confirmed" | "withdraw_locked" | "withdrawable";
  funding_routes?: ("hyperliquid_direct" | "ghola_balance_bridge")[];
  eligibility_commitment?: string | null;
  funding_evidence_commitment?: string | null;
  status: "allocated" | "pending_funding" | "paused" | "revoked";
  session_policy: GholaHyperliquidSessionPolicy;
  allowed_operations: GholaHyperliquidOperationClass[];
  blocked_operations: GholaHyperliquidBlockedOperation[];
  visibility_summary: {
    main_wallet_exposed: boolean;
    ghola_operator_sees: "commitment_and_ciphertext_only";
    hyperliquid_sees: "execution_account_and_order_activity" | "vault_address_and_order_activity";
    public_chain_sees:
      | "no_public_wallet_settlement"
      | "private_funding_evidence_required"
      | "hyperliquid_vault_deposit_and_order_activity";
  };
  created_at: string;
  updated_at: string;
}

export type GholaHyperliquidOperationClass =
  | "read"
  | "limit_order"
  | "cancel"
  | "reconcile";

export type GholaHyperliquidBlockedOperation =
  | "withdraw"
  | "vault_transfer"
  | "leverage_escalation";

export interface GholaHyperliquidExecutionVault {
  version: 1;
  platform_class: "hyperliquid_style_market";
  account_commitment: string;
  vault_commitment: string;
  encrypted_vault_commitment: string;
  recipient_commitment: string;
  policy_commitment: string;
  encrypted_execution_vault: GholaEncryptedPrivateBundle;
  supported_operations: GholaHyperliquidOperationClass[];
  blocked_operations: GholaHyperliquidBlockedOperation[];
  status: "sealed" | "stale" | "revoked";
  created_at: string;
  updated_at: string;
}

export interface GholaHyperliquidSessionPolicy {
  version: 1;
  policy_commitment: string;
  market_allowlist: string[];
  max_notional_bucket: "5" | "10" | "25" | "50" | "100";
  max_order_count: number;
  expires_at: string;
  kill_switch: boolean;
  allowed_operations: GholaHyperliquidOperationClass[];
  blocked_operations: GholaHyperliquidBlockedOperation[];
  strategy_commitment: string;
  prompt_commitment: string;
  created_at: string;
}

export interface GholaPrivateAccountAction {
  version: 1;
  action_commitment: string;
  action_class: GholaPrivateAccountActionClass;
  product_bucket: string;
  policy_commitment: string;
  intent_commitment: string;
  created_at: string;
}

export interface GholaLeakageMap {
  version: 1;
  leakage_commitment: string;
  channels: Record<
    | "source_wallet_graph"
    | "destination_wallet_graph"
    | "platform_account_linkage"
    | "asset_visibility"
    | "amount_visibility"
    | "timing_urgency"
    | "side_direction"
    | "quote_path"
    | "counterparty_set"
    | "solver_set"
    | "settlement_linkage"
    | "cross_run_pattern",
    GholaLeakageStatus
  >;
}

export interface GholaPrivacyPreview {
  version: 1;
  preview_commitment: string;
  account_commitment: string;
  action_commitment: string;
  platform_class: GholaPlatformClass;
  selected_rail: GholaRailKind;
  claim_status: GholaClaimStatus;
  anonymity_level: GholaAnonymityLevel;
  threat_model: GholaThreatModel;
  anonymity_set: GholaAnonymitySetSummary;
  leakage_map: GholaLeakageMap;
  public_chain_sees: "hidden" | "bucketed" | "visible" | "blocked";
  platform_sees: "none" | "minimal" | "order_visible" | "account_visible";
  ghola_operator_sees: "commitment_only" | "sealed_runtime" | "runtime_visible";
  counterparty_sees: "none" | "ticket_only" | "selected_quote_only" | "order_visible";
  hidden_from: string[];
  visible_to: string[];
  degraded_reasons: string[];
  blocked_reasons: string[];
  wait_reasons: string[];
  evidence_status: GholaPrivateModeEvidenceStatus;
  evidence_chain: GholaPrivateModeEvidenceChain | null;
  connector_context: GholaConnectorPreviewContext | null;
  sealed_runtime_context: GholaSealedRuntimeContext | null;
  schedule_decision: GholaPrivacyScheduleDecision | null;
  rotation: GholaPlatformFundingRotation | null;
  linkability_simulation: GholaAdversarialLinkabilitySimulation | null;
  front_run_mode: FrontRunMode;
  front_run_protection: FrontRunProtection;
  front_run_certificate_commitment: string | null;
  claim_levels_achieved: GholaPrivateModeClaimLevel[];
  claim_levels_missing: GholaPrivateModeClaimLevel[];
  claim_evidence_commitments: Partial<Record<GholaPrivateModeClaimLevel, string>>;
  expires_at: string;
}

export interface GholaPrivateAccountReceipt {
  version: 1;
  receipt_commitment: string;
  action_commitment: string;
  preview_commitment: string;
  result: "executed" | "blocked" | "expired" | "cancelled";
  privacy_level: GholaAnonymityLevel;
  claim_status: GholaClaimStatus;
  hidden_from: string[];
  visible_to: string[];
  degraded_reasons: string[];
  blocked_reasons: string[];
  anonymity_set: GholaAnonymitySetSummary;
  rail_used: GholaRailKind;
  platform_visibility: string;
  public_chain_visibility: string;
  operator_visibility: string;
  approval_commitment: string;
  execution_commitment: string;
  execution_plan_commitment: string | null;
  settlement_commitment: string | null;
  relay_commitment: string | null;
  finality_commitment: string | null;
  manifest_commitment: string | null;
  connector_readiness_commitment: string | null;
  compiler_commitment: string | null;
  linkability_score_commitment: string | null;
  work_order_commitment: string | null;
  connector_result_commitment: string | null;
  platform_fee_policy_commitment: string | null;
  runtime_envelope_commitment: string | null;
  runtime_attestation_commitment: string | null;
  runtime_health_commitment: string | null;
  schedule_commitment: string | null;
  rotation_commitment: string | null;
  simulator_commitment: string | null;
  venue_access_source: GholaConnectorPreviewContext["venue_access_source"] | null;
  ghola_access_role: GholaConnectorPreviewContext["ghola_access_role"] | null;
  venue_gate: GholaConnectorPreviewContext["venue_gate"] | null;
  venue_visibility: GholaConnectorPreviewContext["venue_visibility"] | null;
  source_wallet_visibility: GholaConnectorPreviewContext["source_wallet_visibility"] | null;
  privacy_claim: GholaConnectorPreviewContext["privacy_claim"] | null;
  front_run_mode: FrontRunMode;
  front_run_protection: FrontRunProtection;
  front_run_certificate_commitment: string | null;
  zero_front_run: boolean;
  claim_levels_achieved: GholaPrivateModeClaimLevel[];
  claim_levels_missing: GholaPrivateModeClaimLevel[];
  claim_evidence_commitments: Partial<Record<GholaPrivateModeClaimLevel, string>>;
  evidence_chain: GholaPrivateModeEvidenceChain | null;
  selective_disclosure_available: boolean;
  signature: string;
}

export interface GholaPrivateRailStep {
  version: 1;
  step_commitment: string;
  rail: GholaRailKind;
  status: "planned" | "selected" | "skipped" | "blocked";
  reason: string | null;
}

export interface GholaShieldedPoolServiceHealth {
  version: 1;
  service:
    | "indexer"
    | "tree_state"
    | "prover"
    | "relayer"
    | "sealed_runtime";
  status: "green" | "red";
  configured: boolean;
  commitment: string | null;
  observed_at: string | null;
  reason: string | null;
}

export interface GholaShieldedPoolHealth {
  version: 1;
  status: "green" | "red";
  mode: "http" | "local_test" | "unconfigured";
  network: string;
  program_commitment: string | null;
  mint_commitment: string | null;
  tree_commitment: string | null;
  min_confirmations: number;
  max_stale_ms: number;
  indexer: GholaShieldedPoolServiceHealth;
  tree_state: GholaShieldedPoolServiceHealth;
  prover: GholaShieldedPoolServiceHealth;
  relayer: GholaShieldedPoolServiceHealth;
  sealed_runtime: GholaShieldedPoolServiceHealth;
  checked_at: string;
  reason: string | null;
}

export interface GholaPrivateExecutionPlan {
  version: 1;
  plan_commitment: string;
  preview_commitment: string;
  account_commitment: string;
  action_commitment: string;
  platform_class: GholaPlatformClass;
  selected_rail: GholaRailKind;
  settlement_kind:
    | "none"
    | "internal_private_state"
    | "vault_netting"
    | "shielded_batch_auction"
    | "shielded_batch"
    | "shielded_pool_withdraw";
  settlement_required: boolean;
  status: "ready" | "waiting" | "blocked" | "degraded";
  rail_steps: GholaPrivateRailStep[];
  shielded_pool_health_commitment: string | null;
  sealed_runtime_status: "green" | "red" | "not_required";
  evidence_chain_commitment: string | null;
  manifest_commitment: string | null;
  connector_readiness_commitment: string | null;
  compiler_commitment: string | null;
  linkability_score_commitment: string | null;
  sandbox_policy_commitment: string | null;
  runtime_envelope_commitment: string | null;
  runtime_attestation_commitment: string | null;
  runtime_health_commitment: string | null;
  schedule_commitment: string | null;
  rotation_commitment: string | null;
  simulator_commitment: string | null;
  front_run_mode: FrontRunMode;
  front_run_protection: FrontRunProtection;
  front_run_certificate_commitment: string | null;
  claim_levels_achieved: GholaPrivateModeClaimLevel[];
  claim_levels_missing: GholaPrivateModeClaimLevel[];
  wait_reasons: string[];
  blocked_reasons: string[];
  created_at: string;
  expires_at: string;
}

export interface GholaRelayStatusEvidence {
  version: 1;
  relay_commitment: string;
  status_commitment: string;
  status: "accepted" | "finalized" | "failed" | "unknown";
  observed_at: string;
}

export interface GholaShieldedSettlementEvidence {
  version: 1;
  settlement_commitment: string;
  execution_plan_commitment: string;
  preview_commitment: string;
  approval_commitment: string;
  execution_commitment: string;
  rail: GholaRailKind;
  network: string;
  lifecycle_status: GholaPrivateSettlementLifecycleStatus;
  root_commitment: string | null;
  proof_commitment: string;
  witness_commitment: string;
  attestation: GholaRuntimeAttestationEvidence | null;
  attestation_commitment: string | null;
  relay_status: GholaRelayStatusEvidence;
  finality_commitment: string;
  settled_at: string;
}

export interface GholaReceiptVerificationResult {
  version: 1;
  receipt_commitment: string;
  verified: boolean;
  claim_status: GholaClaimStatus;
  checks: Record<
    | "receipt_found"
    | "preview_bound"
    | "approval_bound"
    | "execution_bound"
    | "funding_import_bound"
    | "batch_evidence_bound"
    | "execution_plan_bound"
    | "settlement_bound"
    | "witness_bound"
    | "proof_bound"
    | "relay_bound"
    | "finality_bound"
    | "attestation_bound"
    | "manifest_bound"
    | "connector_readiness_bound"
    | "compiler_bound"
    | "linkability_bound"
    | "work_order_bound"
    | "connector_result_bound"
    | "platform_fee_policy_bound"
    | "runtime_envelope_bound"
    | "runtime_attestation_bound"
    | "schedule_bound"
    | "rotation_bound"
    | "simulator_bound"
    | "front_run_bound"
    | "claim_levels_bound",
    "pass" | "fail" | "not_required"
  >;
  errors: string[];
}

export type GholaPrivateSettlementLifecycleStatus =
  | "planned"
  | "proof_requested"
  | "proof_ready"
  | "relay_submitted"
  | "finality_pending"
  | "finalized"
  | "failed"
  | "expired";

export type GholaAuctionLifecycleStatus =
  | "open"
  | "closing"
  | "cleared"
  | "settling"
  | "settled"
  | "expired"
  | "failed";

export type GholaAuctionOrderSide = "buy" | "sell" | "not_applicable";

export interface GholaAuctionEpochSummary {
  version: 1;
  auction_epoch_commitment: string;
  market_commitment: string;
  platform_class: GholaPlatformClass;
  asset_bucket: string;
  amount_bucket: string;
  status: GholaAuctionLifecycleStatus;
  order_count: number;
  matched_count: number;
  rolled_count: number;
  opened_at: string;
  closes_at: string;
  updated_at: string;
}

export interface GholaAuctionOrderSummary {
  version: 1;
  auction_order_commitment: string;
  auction_epoch_commitment: string;
  queue_id: string;
  intent_id: string;
  action_commitment: string;
  action_class: GholaPrivateAccountActionClass;
  platform_class: GholaPlatformClass;
  side: GholaAuctionOrderSide;
  asset_bucket: string;
  amount_bucket: string;
  status: "committed" | "matched" | "rolled" | "settled" | "cancelled" | "expired";
  created_at: string;
  updated_at: string;
}

export interface GholaAuctionClearingSummary {
  version: 1;
  clearing_commitment: string;
  auction_epoch_commitment: string;
  status: "cleared" | "settled" | "failed";
  clearing_price_commitment: string;
  matched_order_commitments: string[];
  rolled_order_commitments: string[];
  proof_commitment: string;
  settlement_commitment: string | null;
  created_at: string;
  updated_at: string;
}

export interface GholaRuntimeAttestationEvidence {
  version: 1;
  attestation_commitment: string;
  runtime_commitment: string;
  measurement_commitment: string;
  policy_commitment: string;
  status: "green" | "red";
  observed_at: string;
}

export interface GholaShieldedWitnessEvidence {
  version: 1;
  root_commitment: string;
  witness_commitment: string;
  root_history_commitment: string | null;
  observed_at: string;
}

export interface GholaShieldedProofEvidence {
  version: 1;
  proof_commitment: string;
  witness_commitment: string;
  prover_commitment: string;
  proof_boundary: "client_local" | "sealed_runtime";
  attestation_commitment: string | null;
  observed_at: string;
}

export interface GholaShieldedRelayEvidence {
  version: 1;
  relay_commitment: string;
  status_commitment: string;
  relay_status: GholaRelayStatusEvidence["status"];
  observed_at: string;
}

export interface GholaShieldedFinalityEvidence {
  version: 1;
  finality_commitment: string;
  relay_commitment: string;
  finalized: boolean;
  observed_at: string;
}

export interface GholaPrivateSettlementLifecycle {
  version: 1;
  lifecycle_commitment: string;
  settlement_commitment: string;
  status: GholaPrivateSettlementLifecycleStatus;
  updated_at: string;
  failure_reason: string | null;
}

export type GholaPrivateModeCanaryKind =
  | "unfunded"
  | "funded_program"
  | "funded_relayer";

export interface GholaPrivateModeCanaryStatus {
  version: 1;
  canary_kind: GholaPrivateModeCanaryKind;
  status: "green" | "red" | "stale" | "missing";
  evidence_commitment: string | null;
  observed_at: string | null;
  expires_at: string | null;
  reason: string | null;
}

export interface GholaPrivateAccountPreviewInput {
  account?: Partial<GholaPrivateExecutionAccount>;
  action: Pick<GholaPrivateAccountAction, "action_class" | "action_commitment" | "intent_commitment" | "policy_commitment" | "product_bucket">;
  platform_class: GholaPlatformClass;
  requested_rail?: GholaRailKind;
  actor?: "consumer" | "institution";
  anonymity_set?: Partial<GholaAnonymitySetSummary>;
  privacy_budget?: Partial<GholaPrivacyBudget>;
  evidence_status?: GholaPrivateModeEvidenceStatus;
  evidence_chain?: GholaPrivateModeEvidenceChain | null;
  connector_context?: GholaConnectorPreviewContext | null;
  sealed_runtime_context?: GholaSealedRuntimeContext | null;
  schedule_decision?: GholaPrivacyScheduleDecision | null;
  rotation?: GholaPlatformFundingRotation | null;
  linkability_simulation?: GholaAdversarialLinkabilitySimulation | null;
  front_run_mode?: FrontRunMode;
  require_private_mode_evidence?: boolean;
  degraded_accepted?: boolean;
  now?: Date;
}

export interface GholaPrivateAccountIntentBinding {
  intent_id: string;
  account_commitment: string;
  action_commitment: string;
  action_class: GholaPrivateAccountActionClass;
  product_bucket: string;
  policy_commitment: string;
  intent_commitment: string;
  expires_at: string;
}

export interface GholaPrivateAccountApprovalBinding {
  approval_commitment: string;
  preview_commitment: string;
  intent_id: string;
  degraded_accepted: boolean;
  expires_at: string;
  execution_plan_commitment?: string | null;
}

export const DEFAULT_ANONYMITY_SET_POLICY: GholaAnonymitySetPolicy = {
  version: 1,
  consumer_min_effective_set: 50,
  institutional_min_effective_set: 100,
  rfq_min_solver_count: 5,
  amount_bucket_micro_usd: [5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000],
  min_delay_seconds: 600,
};

const MAX_FULL_ANONYMITY_RAILS: GholaRailKind[] = [
  "private_state_only",
  "vault_omnibus_netting",
  "combined_vault_shielded_batch",
  "shielded_batch_auction",
  "shielded_pool",
  "confidential_token",
];

const ROUTING_ORDER: GholaRailKind[] = [
  ...MAX_FULL_ANONYMITY_RAILS,
  "provider_omnibus_subaccount",
  "private_relayer",
  "stealth_change_address",
  "direct_public_fallback",
];

const PRIVATE_MODE_REQUIRED_CLAIM_LEVELS: GholaPrivateModeClaimLevel[] = [
  "source_wallet_hidden",
  "amount_bucketed",
  "batched_anonymity_set",
  "operator_sealed",
];

export function requiresPrivateSettlementBinding(rail: GholaRailKind): boolean {
  return rail === "shielded_pool" || rail === "shielded_batch_auction";
}

function canClaimFullRfqBatchAnonymity(input: {
  platformClass: GholaPlatformClass;
  selectedRail: GholaRailKind;
  evidenceStatus: GholaPrivateModeEvidenceStatus;
  evidenceChain: GholaPrivateModeEvidenceChain | null;
  connectorContext: GholaConnectorPreviewContext | null;
  sealedRuntimeContext: GholaSealedRuntimeContext | null;
  scheduleDecision: GholaPrivacyScheduleDecision | null;
  rotation: GholaPlatformFundingRotation | null;
  linkabilitySimulation: GholaAdversarialLinkabilitySimulation | null;
  claimLevels: {
    achieved: GholaPrivateModeClaimLevel[];
    missing: GholaPrivateModeClaimLevel[];
    evidence: Partial<Record<GholaPrivateModeClaimLevel, string>>;
  };
}): boolean {
  return input.platformClass === "rfq_solver_network" &&
    input.selectedRail === "shielded_batch_auction" &&
    input.evidenceStatus === "ready" &&
    input.claimLevels.missing.length === 0 &&
    Boolean(input.evidenceChain?.batch_evidence_commitment) &&
    connectorFullPrivateReady(input.connectorContext) &&
    sealedRuntimeFullPrivateReady(input.sealedRuntimeContext) &&
    input.scheduleDecision?.status === "ready" &&
    Boolean(input.scheduleDecision.schedule_commitment) &&
    input.rotation?.status === "ready" &&
    Boolean(input.rotation.rotation_commitment) &&
    input.linkabilitySimulation?.decision === "proceed" &&
    Boolean(input.linkabilitySimulation.simulator_commitment);
}

function connectorFullPrivateReady(context: GholaConnectorPreviewContext | null): boolean {
  return Boolean(
    context &&
      context.connector_status === "ready" &&
      context.linkability_decision === "proceed" &&
      context.main_wallet_exposed === false &&
      context.privacy_claim === "private_mode_available" &&
      context.manifest_commitment &&
      context.connector_readiness_commitment &&
      context.compiler_commitment &&
      context.linkability_score_commitment
  );
}

function sealedRuntimeFullPrivateReady(context: GholaSealedRuntimeContext | null): boolean {
  return Boolean(
    context &&
      context.runtime_status === "ready" &&
      context.runtime_envelope_commitment &&
      context.runtime_attestation_commitment &&
      context.runtime_health_commitment
  );
}

export function stablePrivateAccountJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stablePrivateAccountJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stablePrivateAccountJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function gholaCommitment(prefix: string, value: unknown): string {
  return `${prefix}_${bytesToHex(sha256(new TextEncoder().encode(stablePrivateAccountJson(value)))).slice(0, 48)}`;
}

export function listPlatformPrivacyProfiles(): GholaPlatformPrivacyProfile[] {
  return [
    profile("solana_public_wallet", "Solana public wallet", ["pay", "transfer", "withdraw"], "visible", "none", "runtime_visible", "none", [], [
      "direct public settlement exposes sender, receiver, asset, amount, and timing",
    ], []),
    profile("solana_private_balance", "Solana private balance", ["pay", "transfer", "withdraw"], "hidden", "none", "sealed_runtime", "none", [
      "private_state_only",
      "vault_omnibus_netting",
      "combined_vault_shielded_batch",
      "shielded_batch_auction",
      "shielded_pool",
    ], [], ["direct public fallback cannot satisfy Private Mode"]),
    profile("solana_perps_market", "Solana perps market", ["fund_platform", "trade_on_platform", "rebalance"], "bucketed", "order_visible", "sealed_runtime", "order_visible", [
      "shielded_batch_auction",
      "combined_vault_shielded_batch",
      "shielded_pool",
    ], ["venue and Solana programs see venue-account order activity", "unique size or timing can link private funding to venue action"], ["raw withdrawals, leverage escalation, staking, and custody transfers are blocked"]),
    profile("solana_swap_aggregator", "Solana swap aggregator", ["trade_on_platform", "rebalance"], "bucketed", "minimal", "sealed_runtime", "selected_quote_only", [
      "shielded_batch_auction",
      "combined_vault_shielded_batch",
      "shielded_pool",
    ], ["selected route or settlement can be public on Solana"], ["direct user-wallet swaps cannot satisfy Private Mode"]),
    profile("hyperliquid_style_market", "Hyperliquid-style market", ["fund_platform", "trade_on_platform", "rebalance"], "bucketed", "order_visible", "sealed_runtime", "order_visible", [
      "shielded_batch_auction",
      "combined_vault_shielded_batch",
      "shielded_pool",
    ], ["venue sees order/account activity", "unique size or timing can link source funding to venue action"], ["raw withdrawals, leverage, staking, and vault transfers are blocked"]),
    profile("coinbase_style_provider", "Coinbase Advanced provider", ["fund_platform", "trade_on_platform", "rebalance"], "bucketed", "account_visible", "sealed_runtime", "none", [
      "shielded_batch_auction",
      "provider_omnibus_subaccount",
      "vault_omnibus_netting",
      "combined_vault_shielded_batch",
      "shielded_pool",
    ], ["Coinbase or the omnibus partner sees pooled account/order activity", "BYO API-key mode is account-visible to Coinbase"], ["withdrawals, transfers, margin, leverage, staking, and portfolio mutation are blocked by default"]),
    profile("rfq_solver_network", "RFQ solver network", ["trade_on_platform", "rebalance"], "bucketed", "minimal", "sealed_runtime", "ticket_only", [
      "shielded_batch_auction",
      "combined_vault_shielded_batch",
      "shielded_pool",
    ], ["selected solver sees quote ticket"], ["single-solver or exact-size RFQ blocks Private Mode"]),
    profile("partner_tokenized_assets", "Partner-gated tokenized assets", ["trade_on_platform", "rebalance"], "blocked", "account_visible", "sealed_runtime", "none", [], [], [
      "partner eligibility and compliance commitments are required before execution",
    ]),
  ];
}

export function getPlatformPrivacyProfile(platformClass: GholaPlatformClass): GholaPlatformPrivacyProfile {
  const found = listPlatformPrivacyProfiles().find((item) => item.platform_class === platformClass);
  if (!found) throw new Error(`unsupported platform class: ${platformClass}`);
  return found;
}

export function createPrivateExecutionAccount(input: {
  sessionId?: string;
  turnkeyWalletId?: string;
  vaultSeed?: string;
  policySeed?: string;
  platformSeed?: string;
  vaultReady?: boolean;
} = {}): GholaPrivateExecutionAccount {
  const session = gholaCommitment("session", input.sessionId || "anonymous-session");
  const wallet = gholaCommitment("wallet", input.turnkeyWalletId || "turnkey-wallet");
  const vault = gholaCommitment("vault", input.vaultSeed || "private-vault");
  const policy = gholaCommitment("policy", input.policySeed || "private-mode-default");
  const platform = gholaCommitment("platforms", input.platformSeed || "no-linked-platforms");
  return {
    version: 1,
    account_commitment: gholaCommitment("acct", { session, wallet, vault, policy, platform }),
    session_commitment: session,
    turnkey_wallet_commitment: wallet,
    vault_root_commitment: vault,
    policy_commitment: policy,
    platform_link_root: platform,
    privacy_mode: "private_mode",
    claim_boundary: "engine_gated_full_anonymity",
    vault_ready: input.vaultReady ?? false,
  };
}

export function createEncryptedPrivateBundle(input: {
  alg?: GholaEncryptedBundleAlg;
  ciphertext: string;
  recipient: string;
  aad: string;
  encapsulated_key?: string | null;
}): { ok: true; bundle: GholaEncryptedPrivateBundle } | { ok: false; error: "encrypted_bundle_invalid" } {
  const alg = input.alg ?? "sealed-provider-v1";
  if (
    (alg !== "sealed-provider-v1" && alg !== "hpke-x25519-aes256gcm") ||
    !input.ciphertext.trim() ||
    !input.recipient.trim() ||
    !input.aad.trim()
  ) {
    return { ok: false, error: "encrypted_bundle_invalid" };
  }
  return {
    ok: true,
    bundle: {
      version: 1,
      alg,
      ciphertext: input.ciphertext,
      ciphertext_commitment: gholaCommitment("encrypted_bundle_ciphertext", input.ciphertext),
      recipient: input.recipient,
      recipient_commitment: gholaCommitment("sealed_recipient", input.recipient),
      aad: input.aad,
      aad_commitment: gholaCommitment("encrypted_bundle_aad", input.aad),
      encapsulated_key_commitment: input.encapsulated_key
        ? gholaCommitment("encrypted_bundle_encapsulated_key", input.encapsulated_key)
        : null,
    },
  };
}

export function createVenueExecutionVault(input: {
  venue_id: GholaVenueId;
  execution_mode?: GholaVenueExecutionMode;
  account_mode?: GholaVenueAccountMode;
  account_commitment: string;
  encrypted_execution_vault: {
    alg?: GholaEncryptedBundleAlg;
    ciphertext: string;
    recipient: string;
    aad: string;
    encapsulated_key?: string | null;
  };
  allocation_commitment?: string | null;
  policy_seed?: unknown;
  now?: Date;
}): { ok: true; vault: GholaVenueExecutionVault } | { ok: false; error: "encrypted_bundle_invalid" | "forbidden_raw_venue_field" } {
  if (containsForbiddenPublicPrivateAccountField(input.encrypted_execution_vault)) {
    return { ok: false, error: "forbidden_raw_venue_field" };
  }
  const encrypted = createEncryptedPrivateBundle(input.encrypted_execution_vault);
  if (!encrypted.ok) return encrypted;
  const now = input.now ?? new Date();
  const executionMode = input.execution_mode ?? "byo_api_key";
  const accountMode = input.account_mode ?? accountModeForExecutionMode(executionMode);
  const platformClass = venuePlatformClass(input.venue_id);
  const policyCommitment = gholaCommitment("venue_execution_policy", {
    venue_id: input.venue_id,
    execution_mode: executionMode,
    account_mode: accountMode,
    account_commitment: input.account_commitment,
    seed: input.policy_seed ?? "ghola-venue-private-execution-v1",
  });
  const vaultSeed = {
    venue_id: input.venue_id,
    execution_mode: executionMode,
    account_mode: accountMode,
    account_commitment: input.account_commitment,
    encrypted_vault_commitment: encrypted.bundle.ciphertext_commitment,
    recipient_commitment: encrypted.bundle.recipient_commitment,
    policy_commitment: policyCommitment,
    allocation_commitment: input.allocation_commitment ?? null,
  };
  return {
    ok: true,
    vault: {
      version: 1,
      venue_id: input.venue_id,
      platform_class: platformClass,
      execution_mode: executionMode,
      account_mode: accountMode,
      account_commitment: input.account_commitment,
      vault_commitment: gholaCommitment("venue_execution_vault", vaultSeed),
      encrypted_vault_commitment: gholaCommitment("venue_encrypted_vault", vaultSeed),
      recipient_commitment: encrypted.bundle.recipient_commitment,
      policy_commitment: policyCommitment,
      allocation_commitment: input.allocation_commitment ?? null,
      encrypted_execution_vault: encrypted.bundle,
      supported_operations: supportedVenueOperations(input.venue_id),
      blocked_operations: blockedVenueOperations(input.venue_id, executionMode),
      status: "sealed",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
  };
}

export function createCoinbaseAdvancedExecutionVault(input: {
  account_commitment: string;
  execution_mode?: GholaVenueExecutionMode;
  encrypted_execution_vault: {
    alg?: GholaEncryptedBundleAlg;
    ciphertext: string;
    recipient: string;
    aad: string;
    encapsulated_key?: string | null;
  };
  allocation_commitment?: string | null;
  policy_seed?: unknown;
  now?: Date;
}): ReturnType<typeof createVenueExecutionVault> {
  return createVenueExecutionVault({
    venue_id: "coinbase_advanced",
    execution_mode: input.execution_mode ?? "byo_api_key",
    account_commitment: input.account_commitment,
    encrypted_execution_vault: input.encrypted_execution_vault,
    allocation_commitment: input.allocation_commitment,
    policy_seed: input.policy_seed,
    now: input.now,
  });
}

export function createHyperliquidExecutionVault(input: {
  account_commitment: string;
  encrypted_execution_vault: {
    alg?: GholaEncryptedBundleAlg;
    ciphertext: string;
    recipient: string;
    aad: string;
    encapsulated_key?: string | null;
  };
  policy_seed?: unknown;
  now?: Date;
}): { ok: true; vault: GholaHyperliquidExecutionVault } | { ok: false; error: "encrypted_bundle_invalid" | "forbidden_raw_hyperliquid_field" } {
  if (containsForbiddenPublicPrivateAccountField(input.encrypted_execution_vault)) {
    return { ok: false, error: "forbidden_raw_hyperliquid_field" };
  }
  const encrypted = createEncryptedPrivateBundle(input.encrypted_execution_vault);
  if (!encrypted.ok) return encrypted;
  const now = input.now ?? new Date();
  const policyCommitment = gholaCommitment("hyperliquid_execution_policy", {
    account_commitment: input.account_commitment,
    seed: input.policy_seed ?? "ghola-hyperliquid-private-execution-v1",
  });
  const vaultSeed = {
    account_commitment: input.account_commitment,
    encrypted_vault_commitment: encrypted.bundle.ciphertext_commitment,
    recipient_commitment: encrypted.bundle.recipient_commitment,
    policy_commitment: policyCommitment,
  };
  return {
    ok: true,
    vault: {
      version: 1,
      platform_class: "hyperliquid_style_market",
      account_commitment: input.account_commitment,
      vault_commitment: gholaCommitment("hyperliquid_execution_vault", vaultSeed),
      encrypted_vault_commitment: gholaCommitment("hyperliquid_encrypted_vault", vaultSeed),
      recipient_commitment: encrypted.bundle.recipient_commitment,
      policy_commitment: policyCommitment,
      encrypted_execution_vault: encrypted.bundle,
      supported_operations: ["read", "limit_order", "cancel", "reconcile"],
      blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
      status: "sealed",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
  };
}

export function createVenueSessionPolicy(input: {
  venue_id: GholaVenueId;
  execution_mode?: GholaVenueExecutionMode;
  market_allowlist?: string[];
  max_notional_bucket?: GholaVenueSessionPolicy["max_notional_bucket"];
  max_order_count?: number;
  ttl_ms?: number;
  kill_switch?: boolean;
  allowed_operations?: GholaVenueOperationClass[];
  strategy_seed?: unknown;
  prompt_seed?: unknown;
  now?: Date;
}): GholaVenueSessionPolicy {
  const now = input.now ?? new Date();
  const executionMode = input.execution_mode ?? "byo_api_key";
  const defaultAllowed = supportedVenueOperations(input.venue_id);
  const allowed = (input.allowed_operations?.length ? input.allowed_operations : defaultAllowed)
    .filter((operation, index, all) =>
      defaultAllowed.includes(operation) && all.indexOf(operation) === index
    );
  const marketAllowlist = (input.market_allowlist?.length
    ? input.market_allowlist
    : input.venue_id === "coinbase_advanced"
      ? ["BTC-USD", "ETH-USD", "SOL-USD"]
      : ["BTC", "ETH", "SOL"]).map((item) => item.trim().toUpperCase()).filter(Boolean);
  const maxOrderCount = Math.max(0, Math.min(100, Math.floor(input.max_order_count ?? 10)));
  const maxNotionalBucket = input.max_notional_bucket ?? "25";
  const expiresAt = new Date(now.getTime() + Math.max(60_000, input.ttl_ms ?? 30 * 60 * 1000)).toISOString();
  const strategyCommitment = gholaCommitment("venue_strategy", input.strategy_seed ?? "sealed_strategy_only");
  const promptCommitment = gholaCommitment("venue_prompt", input.prompt_seed ?? "sealed_prompt_only");
  const seed = {
    venueId: input.venue_id,
    executionMode,
    marketAllowlist,
    maxNotionalBucket,
    maxOrderCount,
    expiresAt,
    killSwitch: input.kill_switch === true,
    allowed,
    strategyCommitment,
    promptCommitment,
  };
  return {
    version: 1,
    venue_id: input.venue_id,
    execution_mode: executionMode,
    policy_commitment: gholaCommitment("venue_session_policy", seed),
    market_allowlist: marketAllowlist,
    max_notional_bucket: maxNotionalBucket,
    max_order_count: maxOrderCount,
    expires_at: expiresAt,
    kill_switch: input.kill_switch === true,
    allowed_operations: allowed,
    blocked_operations: blockedVenueOperations(input.venue_id, executionMode),
    strategy_commitment: strategyCommitment,
    prompt_commitment: promptCommitment,
    created_at: now.toISOString(),
  };
}

export function createHyperliquidSessionPolicy(input: {
  market_allowlist?: string[];
  max_notional_bucket?: GholaHyperliquidSessionPolicy["max_notional_bucket"];
  max_order_count?: number;
  ttl_ms?: number;
  kill_switch?: boolean;
  allowed_operations?: GholaHyperliquidOperationClass[];
  strategy_seed?: unknown;
  prompt_seed?: unknown;
  now?: Date;
} = {}): GholaHyperliquidSessionPolicy {
  const now = input.now ?? new Date();
  const defaultAllowed: GholaHyperliquidOperationClass[] = ["read", "limit_order", "cancel", "reconcile"];
  const allowed: GholaHyperliquidOperationClass[] = (input.allowed_operations?.length
    ? input.allowed_operations
    : defaultAllowed).filter((operation, index, all) =>
    all.indexOf(operation) === index
  );
  const marketAllowlist = (input.market_allowlist?.length
    ? input.market_allowlist
    : ["BTC", "ETH", "SOL"]).map((item) => item.trim().toUpperCase()).filter(Boolean);
  const maxOrderCount = Math.max(0, Math.min(100, Math.floor(input.max_order_count ?? 10)));
  const maxNotionalBucket = input.max_notional_bucket ?? "25";
  const expiresAt = new Date(now.getTime() + Math.max(60_000, input.ttl_ms ?? 30 * 60 * 1000)).toISOString();
  const strategyCommitment = gholaCommitment("hyperliquid_strategy", input.strategy_seed ?? "sealed_strategy_only");
  const promptCommitment = gholaCommitment("hyperliquid_prompt", input.prompt_seed ?? "sealed_prompt_only");
  const seed = {
    marketAllowlist,
    maxNotionalBucket,
    maxOrderCount,
    expiresAt,
    killSwitch: input.kill_switch === true,
    allowed,
    strategyCommitment,
    promptCommitment,
  };
  return {
    version: 1,
    policy_commitment: gholaCommitment("hyperliquid_session_policy", seed),
    market_allowlist: marketAllowlist,
    max_notional_bucket: maxNotionalBucket,
    max_order_count: maxOrderCount,
    expires_at: expiresAt,
    kill_switch: input.kill_switch === true,
    allowed_operations: allowed,
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
    strategy_commitment: strategyCommitment,
    prompt_commitment: promptCommitment,
    created_at: now.toISOString(),
  };
}

export function createHyperliquidManagedAllocation(input: {
  account_commitment: string;
  policy?: GholaHyperliquidSessionPolicy;
  execution_mode?: GholaHyperliquidManagedAllocation["execution_mode"];
  network?: "testnet" | "mainnet";
  vault_address?: string | null;
  vault_controller_address?: string | null;
  agent_wallet_commitment?: string | null;
  deposit_evidence_commitment?: string | null;
  deposit_status?: GholaHyperliquidManagedAllocation["deposit_status"];
  funding_routes?: GholaHyperliquidManagedAllocation["funding_routes"];
  eligibility_commitment?: string | null;
  funding_evidence_commitment?: string | null;
  pool_seed?: unknown;
  allocation_seed?: unknown;
  now?: Date;
}): GholaHyperliquidManagedAllocation {
  const now = input.now ?? new Date();
  const policy = input.policy ?? createHyperliquidSessionPolicy({ now });
  const executionMode = input.execution_mode ?? "managed_testnet";
  const network = executionMode === "managed_testnet" ? "testnet" : input.network ?? "mainnet";
  const poolCommitment = gholaCommitment("hyperliquid_managed_pool", {
    seed: input.pool_seed ??
      (executionMode === "hyperliquid_native_vault"
        ? "ghola-native-vault-mainnet-v1"
        : executionMode === "ghola_pooled"
          ? "ghola-pooled-mainnet-v1"
          : "ghola-managed-testnet-v1"),
    execution_mode: executionMode,
    network,
    vault_address: input.vault_address ?? null,
  });
  const poolShareCommitment = gholaCommitment("hyperliquid_pool_share", {
    account_commitment: input.account_commitment,
    pool_commitment: poolCommitment,
    eligibility_commitment: input.eligibility_commitment ?? null,
    vault_address: input.vault_address ?? null,
  });
  const subledgerAccountCommitment = gholaCommitment("hyperliquid_managed_subledger", {
    account_commitment: input.account_commitment,
    pool_commitment: poolCommitment,
    pool_share_commitment: poolShareCommitment,
  });
  const seed = {
    account_commitment: input.account_commitment,
    execution_mode: executionMode,
    network,
    pool_commitment: poolCommitment,
    pool_share_commitment: poolShareCommitment,
    subledger_account_commitment: subledgerAccountCommitment,
    policy_commitment: policy.policy_commitment,
    vault_address: input.vault_address ?? null,
    vault_controller_address: input.vault_controller_address ?? null,
    agent_wallet_commitment: input.agent_wallet_commitment ?? null,
    deposit_evidence_commitment: input.deposit_evidence_commitment ?? null,
    deposit_status: input.deposit_status ?? "unfunded",
    eligibility_commitment: input.eligibility_commitment ?? null,
    funding_evidence_commitment: input.funding_evidence_commitment ?? null,
    allocation_seed: input.allocation_seed ?? "worker-bound-allocation",
  };
  return {
    version: 1,
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: executionMode,
    network,
    account_commitment: input.account_commitment,
    allocation_commitment: gholaCommitment("hyperliquid_managed_allocation", seed),
    policy_commitment: policy.policy_commitment,
    pool_commitment: poolCommitment,
    pool_share_commitment: poolShareCommitment,
    subledger_account_commitment: subledgerAccountCommitment,
    vault_address: input.vault_address ?? null,
    vault_controller_address: input.vault_controller_address ?? null,
    agent_wallet_commitment: input.agent_wallet_commitment ?? null,
    deposit_evidence_commitment: input.deposit_evidence_commitment ?? null,
    deposit_status: input.deposit_status ?? (executionMode === "hyperliquid_native_vault" ? "unfunded" : undefined),
    funding_routes: input.funding_routes ?? (
      executionMode === "hyperliquid_native_vault"
        ? ["hyperliquid_direct", "ghola_balance_bridge"]
        : undefined
    ),
    eligibility_commitment: input.eligibility_commitment ?? null,
    funding_evidence_commitment: input.funding_evidence_commitment ?? null,
    status: executionMode === "hyperliquid_native_vault"
      ? input.deposit_status === "confirmed" || input.deposit_status === "withdraw_locked" || input.deposit_status === "withdrawable"
        ? "allocated"
        : "pending_funding"
      : executionMode === "ghola_pooled" && !input.eligibility_commitment ? "pending_funding" : "allocated",
    session_policy: policy,
    allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      hyperliquid_sees: executionMode === "hyperliquid_native_vault"
        ? "vault_address_and_order_activity"
        : "execution_account_and_order_activity",
      public_chain_sees: executionMode === "hyperliquid_native_vault"
        ? "hyperliquid_vault_deposit_and_order_activity"
        : executionMode === "ghola_pooled"
          ? "private_funding_evidence_required"
          : "no_public_wallet_settlement",
    },
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

export function validateVenuePolicyExecution(input: {
  policy: GholaVenueSessionPolicy;
  operation: GholaVenueOperationClass | GholaVenueBlockedOperation;
  market?: string | null;
  notional_bucket?: GholaVenueSessionPolicy["max_notional_bucket"] | string | null;
  order_count?: number;
  now?: Date;
}): { ok: true } | { ok: false; errors: string[] } {
  const now = input.now ?? new Date();
  const errors: string[] = [];
  if (input.policy.kill_switch) errors.push("kill_switch_active");
  if (new Date(input.policy.expires_at).getTime() <= now.getTime()) {
    errors.push("policy_expired");
  }
  if (input.policy.blocked_operations.includes(input.operation as GholaVenueBlockedOperation)) {
    errors.push("operation_blocked");
  }
  if (!input.policy.allowed_operations.includes(input.operation as GholaVenueOperationClass)) {
    errors.push("operation_not_allowed");
  }
  const market = input.market?.trim().toUpperCase();
  if (market && !input.policy.market_allowlist.includes(market)) {
    errors.push("market_not_allowed");
  }
  const requestedBucket = typeof input.notional_bucket === "string" && input.notional_bucket
    ? input.notional_bucket
    : input.policy.max_notional_bucket;
  if (bucketRank(requestedBucket) > bucketRank(input.policy.max_notional_bucket)) {
    errors.push("notional_bucket_exceeds_cap");
  }
  if (Math.max(0, Math.floor(input.order_count ?? 0)) >= input.policy.max_order_count) {
    errors.push("order_count_exceeded");
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function validateHyperliquidPolicyExecution(input: {
  policy: GholaHyperliquidSessionPolicy;
  operation: GholaHyperliquidOperationClass | GholaHyperliquidBlockedOperation;
  market?: string | null;
  notional_bucket?: GholaHyperliquidSessionPolicy["max_notional_bucket"] | string | null;
  order_count?: number;
  now?: Date;
}): { ok: true } | { ok: false; errors: string[] } {
  const now = input.now ?? new Date();
  const errors: string[] = [];
  if (input.policy.kill_switch) errors.push("kill_switch_active");
  if (new Date(input.policy.expires_at).getTime() <= now.getTime()) {
    errors.push("policy_expired");
  }
  if (input.policy.blocked_operations.includes(input.operation as GholaHyperliquidBlockedOperation)) {
    errors.push("operation_blocked");
  }
  if (!input.policy.allowed_operations.includes(input.operation as GholaHyperliquidOperationClass)) {
    errors.push("operation_not_allowed");
  }
  const market = input.market?.trim().toUpperCase();
  if (market && !input.policy.market_allowlist.includes(market)) {
    errors.push("market_not_allowed");
  }
  const requestedBucket = typeof input.notional_bucket === "string" && input.notional_bucket
    ? input.notional_bucket
    : input.policy.max_notional_bucket;
  if (bucketRank(requestedBucket) > bucketRank(input.policy.max_notional_bucket)) {
    errors.push("notional_bucket_exceeds_cap");
  }
  if (Math.max(0, Math.floor(input.order_count ?? 0)) >= input.policy.max_order_count) {
    errors.push("order_count_exceeded");
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function createPrivateAccountAction(input: {
  action_class: GholaPrivateAccountActionClass;
  product_bucket?: string;
  policy_commitment?: string;
  intent_seed?: unknown;
  now?: Date;
}): GholaPrivateAccountAction {
  const createdAt = (input.now ?? new Date()).toISOString();
  const intentCommitment = gholaCommitment("intent", {
    action_class: input.action_class,
    product_bucket: input.product_bucket || "general",
    seed: input.intent_seed || "commitment-only",
    created_at: createdAt,
  });
  return {
    version: 1,
    action_commitment: gholaCommitment("act", { intentCommitment, createdAt }),
    action_class: input.action_class,
    product_bucket: input.product_bucket || "general",
    policy_commitment: input.policy_commitment || gholaCommitment("policy", "private-mode-default"),
    intent_commitment: intentCommitment,
    created_at: createdAt,
  };
}

export function previewPrivateAccountAction(input: GholaPrivateAccountPreviewInput): GholaPrivacyPreview {
  const profile = getPlatformPrivacyProfile(input.platform_class);
  const accountCommitment = input.account?.account_commitment || gholaCommitment("acct", "preview-account");
  const required =
    input.platform_class === "rfq_solver_network"
      ? DEFAULT_ANONYMITY_SET_POLICY.consumer_min_effective_set
      : input.actor === "institution"
        ? DEFAULT_ANONYMITY_SET_POLICY.institutional_min_effective_set
        : DEFAULT_ANONYMITY_SET_POLICY.consumer_min_effective_set;
  const anonymitySet: GholaAnonymitySetSummary = {
    required: input.anonymity_set?.required ?? required,
    effective: input.anonymity_set?.effective ?? 0,
    solver_count: input.anonymity_set?.solver_count,
    amount_bucketed: input.anonymity_set?.amount_bucketed ?? false,
    timing_window_met: input.anonymity_set?.timing_window_met ?? false,
    uniqueness_score_bps: input.anonymity_set?.uniqueness_score_bps ?? 10_000,
    repeated_pattern_score_bps: input.anonymity_set?.repeated_pattern_score_bps ?? 0,
  };
  const selectedRail = selectRail(profile, input.requested_rail);
  const fullRail = MAX_FULL_ANONYMITY_RAILS.includes(selectedRail);
  const degradedReasons: string[] = [];
  const blockedReasons: string[] =
    profile.platform_class === "partner_tokenized_assets"
      ? [...profile.blocked_conditions]
      : [];
  const waitReasons: string[] = [];

  if (!profile.supported_products.includes(input.action.action_class)) {
    blockedReasons.push("action class is not supported by this platform profile");
  }
  if (input.account?.vault_ready === false && selectedRail !== "direct_public_fallback") {
    waitReasons.push("private account vault is not ready");
  }
  if (!fullRail) {
    degradedReasons.push(`${selectedRail} cannot satisfy Private Mode`);
  }
  if (profile.platform_sees === "order_visible") {
    degradedReasons.push("this platform will see the order");
  }
  if (profile.platform_sees === "account_visible") {
    degradedReasons.push("this provider will see account or custody activity");
  }
  if (profile.public_chain_sees === "visible") {
    degradedReasons.push("public chain will see settlement");
  }
  if (input.platform_class === "rfq_solver_network") {
    if (anonymitySet.solver_count === undefined) {
      waitReasons.push("rfq solver set evidence is not ready");
    } else if (anonymitySet.solver_count < DEFAULT_ANONYMITY_SET_POLICY.rfq_min_solver_count) {
      blockedReasons.push("rfq solver set is below minimum");
    }
  }
  if (anonymitySet.effective < anonymitySet.required) {
    waitReasons.push("effective anonymity set is below required minimum");
  }
  if (!anonymitySet.amount_bucketed) waitReasons.push("amount is not in an approved anonymity bucket");
  if (!anonymitySet.timing_window_met) waitReasons.push("minimum delay window has not elapsed");
  const evidenceStatus = input.evidence_status ?? "none";
  const connectorContext = input.connector_context ?? null;
  const sealedRuntimeContext = input.sealed_runtime_context ?? null;
  const frontRunMode = input.front_run_mode ?? "pre_submit_private";
  const frontRunCertificate = buildFrontRunCertificate({
    accessMode: selectedRail === "shielded_batch_auction" ? "sealed_batch_auction" : connectorContext?.venue_access_source === "user_provided_credentials" ? "byo_api_key" : "unknown",
    auctionEpochCommitment: input.evidence_chain?.auction_epoch_commitment,
    auctionOrderCommitment: input.evidence_chain?.auction_order_commitment,
    clearingCommitment: input.evidence_chain?.clearing_commitment,
    proofCommitment: input.evidence_chain?.proof_commitment,
    finalityCommitment: input.evidence_chain?.finality_commitment,
    runtimeAttestationCommitment: sealedRuntimeContext?.runtime_attestation_commitment ??
      input.evidence_chain?.runtime_attestation_commitment,
  });
  const frontRunProtection = deriveFrontRunProtection({
    accessMode: selectedRail === "shielded_batch_auction" ? "sealed_batch_auction" : connectorContext?.venue_access_source === "user_provided_credentials" ? "byo_api_key" : "unknown",
    frontRunCertificateCommitment: frontRunCertificate?.certificate_commitment ?? null,
    encryptedUntilMatch: selectedRail === "shielded_batch_auction",
    fairOrderingCertificate: Boolean(frontRunCertificate),
    noPublicMempool: selectedRail === "shielded_batch_auction" || connectorContext?.source_wallet_visibility === "not_exposed_to_public_chain_by_ghola",
    uniformBatchAuction: selectedRail === "shielded_batch_auction",
    venueOrderVisible: profile.platform_sees === "order_visible" || connectorContext?.venue_order_visibility === "order_visible",
  });
  if (frontRunMode === "zero_front_run") {
    if (selectedRail !== "shielded_batch_auction") {
      blockedReasons.push("zero-front-run mode requires shielded batch auction rail");
    } else if (!frontRunProtection.canLiveSubmitInZeroMode) {
      waitReasons.push("zero-front-run certificate is not ready");
    }
  }
  const sealedRuntimeRequired = !connectorContext ||
    connectorContext.venue_access_source !== "user_provided_credentials";
  const scheduleDecision = input.schedule_decision ?? null;
  const rotation = input.rotation ?? null;
  const linkabilitySimulation = input.linkability_simulation ?? null;
  if (input.require_private_mode_evidence && fullRail) {
    if (!input.evidence_chain?.batch_evidence_commitment) {
      waitReasons.push("Private Mode evidence commitment is not ready");
    }
    if (evidenceStatus === "stale") waitReasons.push("verifier or coordinator evidence is stale");
    if (evidenceStatus === "unhealthy") waitReasons.push("verifier or coordinator health is not green");
    if (evidenceStatus === "missing") waitReasons.push("batch evidence has not been written");
  }
  if (anonymitySet.uniqueness_score_bps > 2_500) degradedReasons.push("action is too unique for a Private Mode claim");
  if ((input.privacy_budget?.repeated_withdrawal_count ?? 0) > 0) degradedReasons.push("repeated withdrawal pattern reduces anonymity");
  if ((input.privacy_budget?.platform_concentration_bps ?? 0) > 7_500) degradedReasons.push("platform concentration reduces cross-platform anonymity");
  if (sealedRuntimeContext && sealedRuntimeRequired) {
    if (sealedRuntimeContext.runtime_status !== "ready") {
      waitReasons.push(`sealed runtime is ${sealedRuntimeContext.runtime_status}`);
    }
    if (!sealedRuntimeContext.runtime_attestation_commitment) {
      waitReasons.push("sealed runtime attestation commitment is not ready");
    }
    for (const reason of sealedRuntimeContext.reason_codes) {
      if (reason.includes("blocked")) blockedReasons.push(reason);
      else waitReasons.push(reason);
    }
  }
  if (scheduleDecision && sealedRuntimeRequired) {
    if (scheduleDecision.status === "waiting") waitReasons.push("privacy scheduler is waiting for the private window");
    if (scheduleDecision.status === "degraded") degradedReasons.push("fast execution is degraded");
    if (scheduleDecision.status === "blocked") blockedReasons.push("privacy scheduler blocked execution");
    for (const reason of scheduleDecision.reason_codes) {
      if (reason.includes("blocked")) blockedReasons.push(reason);
      else if (reason.includes("degraded") || reason.includes("fast")) degradedReasons.push(reason);
      else waitReasons.push(reason);
    }
  }
  if (rotation) {
    if (rotation.status === "rotate_required") waitReasons.push("platform funding account rotation is required");
    if (rotation.status === "blocked") blockedReasons.push("platform funding account rotation is blocked");
    for (const reason of rotation.reason_codes) {
      if (reason.includes("blocked")) blockedReasons.push(reason);
      else waitReasons.push(reason);
    }
  }
  if (linkabilitySimulation) {
    if (linkabilitySimulation.decision === "blocked") blockedReasons.push("adversarial linkability simulator blocked execution");
    if (linkabilitySimulation.decision === "rotate") waitReasons.push("adversarial simulator requires platform account rotation");
    if (linkabilitySimulation.decision === "wait_for_batch") waitReasons.push("adversarial simulator requires more batching");
    if (linkabilitySimulation.decision === "degraded_acceptance_required") {
      degradedReasons.push("adversarial simulator requires degraded acceptance");
    }
    for (const reason of linkabilitySimulation.reason_codes) {
      if (reason.includes("blocked")) blockedReasons.push(reason);
      else if (reason.includes("degraded") || reason.includes("visibility")) degradedReasons.push(reason);
      else waitReasons.push(reason);
    }
  }
  if (connectorContext) {
    if (connectorContext.connector_status !== "ready") {
      blockedReasons.push(`connector is ${connectorContext.connector_status}`);
    }
    if (connectorContext.linkability_decision === "blocked") {
      blockedReasons.push("cross-platform linkability score blocks execution");
    }
    if (connectorContext.linkability_decision === "rotate_or_block") {
      blockedReasons.push("platform funding account rotation is required");
    }
    if (connectorContext.linkability_decision === "wait_for_batch") {
      waitReasons.push("connector linkability score requires batching");
    }
    if (connectorContext.linkability_decision === "degraded_acceptance_required") {
      degradedReasons.push("cross-platform linkability score requires degraded acceptance");
    }
    if (connectorContext.main_wallet_exposed) {
      degradedReasons.push("your main wallet would be exposed");
    }
    for (const reason of connectorContext.reason_codes) {
      if (reason.includes("blocked")) blockedReasons.push(reason);
      else if (reason.includes("missing") || reason.includes("stale")) waitReasons.push(reason);
      else if (reason.includes("degraded") || reason.includes("visible")) degradedReasons.push(reason);
    }
  }

  let claimStatus: GholaClaimStatus;
  if (frontRunMode === "zero_front_run" && degradedReasons.length > 0) {
    blockedReasons.push("zero-front-run mode does not allow degraded visibility fallback");
  }
  if (blockedReasons.length > 0) claimStatus = "blocked_leaky_path";
  else if (waitReasons.length > 0) claimStatus = "wait_for_anonymity";
  else if (degradedReasons.length > 0) claimStatus = input.degraded_accepted ? "degraded_user_accepted_required" : "degraded_user_accepted_required";
  else claimStatus = "private_mode_available";

  const claimLevels = claimLevelsFor({
    selectedRail,
    fullRail,
    anonymitySet,
    evidenceChain: input.evidence_chain ?? null,
    sealedRuntimeContext,
    claimStatus,
  });
  if (
    isPrivateModeAvailableStatus(claimStatus) &&
    PRIVATE_MODE_REQUIRED_CLAIM_LEVELS.some((level) => !claimLevels.achieved.includes(level))
  ) {
    claimStatus = "wait_for_anonymity";
  }
  if (
    claimStatus === "private_mode_available" &&
    canClaimFullRfqBatchAnonymity({
      platformClass: input.platform_class,
      selectedRail,
      evidenceStatus,
      evidenceChain: input.evidence_chain ?? null,
      connectorContext,
      sealedRuntimeContext,
      scheduleDecision,
      rotation,
      linkabilitySimulation,
      claimLevels,
    })
  ) {
    claimStatus = "full_anonymity_available";
  }
  const anonymityLevel = anonymityLevelFor({ claimStatus, selectedRail, profile });
  const leakageMap = buildLeakageMap({
    actionCommitment: input.action.action_commitment,
    profile,
    selectedRail,
    claimStatus,
  });
  const now = input.now ?? new Date();

  return {
    version: 1,
    preview_commitment: gholaCommitment("preview", {
      accountCommitment,
      action: input.action,
      platform: input.platform_class,
      selectedRail,
      claimStatus,
      anonymityLevel,
      anonymitySet,
      leakageMap,
      evidenceStatus,
      evidenceChain: input.evidence_chain ?? null,
      connectorContext,
      sealedRuntimeContext,
      scheduleDecision,
      rotation,
      linkabilitySimulation,
      claimLevels,
      frontRunMode,
      frontRunProtection,
      frontRunCertificateCommitment: frontRunCertificate?.certificate_commitment ?? null,
    }),
    account_commitment: accountCommitment,
    action_commitment: input.action.action_commitment,
    platform_class: input.platform_class,
    selected_rail: selectedRail,
    claim_status: claimStatus,
    anonymity_level: anonymityLevel,
    threat_model: threatModelFor(profile),
    anonymity_set: anonymitySet,
    leakage_map: leakageMap,
    public_chain_sees: publicChainVisibility(profile, selectedRail, claimStatus),
    platform_sees: profile.platform_sees,
    ghola_operator_sees: profile.ghola_operator_sees,
    counterparty_sees: profile.counterparty_sees,
    hidden_from: hiddenFrom(profile, selectedRail),
    visible_to: visibleTo(profile, selectedRail),
    degraded_reasons: degradedReasons,
    blocked_reasons: blockedReasons,
    wait_reasons: waitReasons,
    evidence_status: evidenceStatus,
    evidence_chain: input.evidence_chain ?? null,
    connector_context: connectorContext,
    sealed_runtime_context: sealedRuntimeContext,
    schedule_decision: scheduleDecision,
    rotation,
    linkability_simulation: linkabilitySimulation,
    front_run_mode: frontRunMode,
    front_run_protection: frontRunProtection,
    front_run_certificate_commitment: frontRunCertificate?.certificate_commitment ?? null,
    claim_levels_achieved: claimLevels.achieved,
    claim_levels_missing: claimLevels.missing,
    claim_evidence_commitments: claimLevels.evidence,
    expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
  };
}

export function approvePrivateAccountAction(input: {
  preview_commitment: string;
  degraded_accepted?: boolean;
  now?: Date;
}) {
  return {
    version: 1 as const,
    approval_commitment: gholaCommitment("approval", input),
    preview_commitment: input.preview_commitment,
    degraded_accepted: input.degraded_accepted === true,
    approved_at: (input.now ?? new Date()).toISOString(),
  };
}

export function buildPrivateAccountReceipt(input: {
  preview: GholaPrivacyPreview;
  approval_commitment: string;
  execution_commitment: string;
  evidence_chain?: GholaPrivateModeEvidenceChain | null;
  secret?: string;
}): GholaPrivateAccountReceipt {
  const evidenceChain = input.evidence_chain
    ? {
        ...input.evidence_chain,
        preview_commitment: input.preview.preview_commitment,
        approval_commitment: input.approval_commitment,
        execution_commitment: input.execution_commitment,
        manifest_commitment: input.preview.connector_context?.manifest_commitment ??
          input.evidence_chain.manifest_commitment ??
          null,
        connector_readiness_commitment: input.preview.connector_context?.connector_readiness_commitment ??
          input.evidence_chain.connector_readiness_commitment ??
          null,
        compiler_commitment: input.preview.connector_context?.compiler_commitment ??
          input.evidence_chain.compiler_commitment ??
          null,
        linkability_score_commitment: input.preview.connector_context?.linkability_score_commitment ??
          input.evidence_chain.linkability_score_commitment ??
          null,
        platform_fee_policy_commitment: input.evidence_chain.platform_fee_policy_commitment ?? null,
        runtime_envelope_commitment: input.preview.sealed_runtime_context?.runtime_envelope_commitment ??
          input.evidence_chain.runtime_envelope_commitment ??
          null,
        runtime_attestation_commitment: input.preview.sealed_runtime_context?.runtime_attestation_commitment ??
          input.evidence_chain.runtime_attestation_commitment ??
          null,
        runtime_health_commitment: input.preview.sealed_runtime_context?.runtime_health_commitment ??
          input.evidence_chain.runtime_health_commitment ??
          null,
        schedule_commitment: input.preview.schedule_decision?.schedule_commitment ??
          input.evidence_chain.schedule_commitment ??
          null,
        rotation_commitment: input.preview.rotation?.rotation_commitment ??
          input.evidence_chain.rotation_commitment ??
          null,
        simulator_commitment: input.preview.linkability_simulation?.simulator_commitment ??
          input.evidence_chain.simulator_commitment ??
          null,
        front_run_certificate_commitment: input.evidence_chain.front_run_certificate_commitment ?? null,
      }
    : null;
  if (isPrivateModeAvailableStatus(input.preview.claim_status) && !evidenceChain?.batch_evidence_commitment) {
    throw new Error("private_mode_evidence_required");
  }
  const unsigned = {
    version: 1 as const,
    receipt_commitment: gholaCommitment("receipt", {
      preview: input.preview.preview_commitment,
      approval: input.approval_commitment,
      execution: input.execution_commitment,
      evidence_chain: evidenceChain,
      front_run_certificate_commitment: input.preview.front_run_certificate_commitment,
    }),
    action_commitment: input.preview.action_commitment,
    preview_commitment: input.preview.preview_commitment,
    result: input.preview.claim_status === "blocked_leaky_path" ? "blocked" as const : "executed" as const,
    privacy_level: input.preview.anonymity_level,
    claim_status: input.preview.claim_status,
    hidden_from: input.preview.hidden_from,
    visible_to: input.preview.visible_to,
    degraded_reasons: input.preview.degraded_reasons,
    blocked_reasons: input.preview.blocked_reasons,
    anonymity_set: input.preview.anonymity_set,
    rail_used: input.preview.selected_rail,
    platform_visibility: input.preview.platform_sees,
    public_chain_visibility: input.preview.public_chain_sees,
    operator_visibility: input.preview.ghola_operator_sees,
    approval_commitment: input.approval_commitment,
    execution_commitment: input.execution_commitment,
    execution_plan_commitment: evidenceChain?.execution_plan_commitment ?? null,
    settlement_commitment: evidenceChain?.settlement_commitment ?? null,
    relay_commitment: evidenceChain?.relay_commitment ?? null,
    finality_commitment: evidenceChain?.finality_commitment ?? null,
    manifest_commitment: evidenceChain?.manifest_commitment ?? input.preview.connector_context?.manifest_commitment ?? null,
    connector_readiness_commitment: evidenceChain?.connector_readiness_commitment ??
      input.preview.connector_context?.connector_readiness_commitment ??
      null,
    compiler_commitment: evidenceChain?.compiler_commitment ?? input.preview.connector_context?.compiler_commitment ?? null,
    linkability_score_commitment: evidenceChain?.linkability_score_commitment ??
      input.preview.connector_context?.linkability_score_commitment ??
      null,
    work_order_commitment: evidenceChain?.work_order_commitment ?? null,
    connector_result_commitment: evidenceChain?.connector_result_commitment ?? null,
    platform_fee_policy_commitment: evidenceChain?.platform_fee_policy_commitment ?? null,
    runtime_envelope_commitment: evidenceChain?.runtime_envelope_commitment ??
      input.preview.sealed_runtime_context?.runtime_envelope_commitment ??
      null,
    runtime_attestation_commitment: evidenceChain?.runtime_attestation_commitment ??
      input.preview.sealed_runtime_context?.runtime_attestation_commitment ??
      null,
    runtime_health_commitment: evidenceChain?.runtime_health_commitment ??
      input.preview.sealed_runtime_context?.runtime_health_commitment ??
      null,
    schedule_commitment: evidenceChain?.schedule_commitment ??
      input.preview.schedule_decision?.schedule_commitment ??
      null,
    rotation_commitment: evidenceChain?.rotation_commitment ??
      input.preview.rotation?.rotation_commitment ??
      null,
    simulator_commitment: evidenceChain?.simulator_commitment ??
      input.preview.linkability_simulation?.simulator_commitment ??
      null,
    venue_access_source: input.preview.connector_context?.venue_access_source ?? null,
    ghola_access_role: input.preview.connector_context?.ghola_access_role ?? null,
    venue_gate: input.preview.connector_context?.venue_gate ?? null,
    venue_visibility: input.preview.connector_context?.venue_visibility ?? null,
    source_wallet_visibility: input.preview.connector_context?.source_wallet_visibility ?? null,
    privacy_claim: input.preview.connector_context?.privacy_claim ?? null,
    front_run_mode: input.preview.front_run_mode,
    front_run_protection: input.preview.front_run_protection,
    front_run_certificate_commitment: evidenceChain?.front_run_certificate_commitment ??
      input.preview.front_run_certificate_commitment ??
      null,
    zero_front_run: input.preview.front_run_protection.zeroFrontRun,
    claim_levels_achieved: input.preview.claim_levels_achieved,
    claim_levels_missing: input.preview.claim_levels_missing,
    claim_evidence_commitments: input.preview.claim_evidence_commitments,
    evidence_chain: evidenceChain,
    selective_disclosure_available: input.preview.claim_levels_achieved.includes("selectively_disclosable") ||
      input.preview.anonymity_level === "P5_selectively_disclosable",
  };
  if (
    isPrivateModeAvailableStatus(input.preview.claim_status) &&
    !evidenceChain?.execution_plan_commitment
  ) {
    throw new Error("private_mode_execution_plan_required");
  }
  if (
    isPrivateModeAvailableStatus(input.preview.claim_status) &&
    requiresPrivateSettlementBinding(input.preview.selected_rail) &&
    !evidenceChain?.settlement_commitment
  ) {
    throw new Error("private_mode_settlement_evidence_required");
  }
  if (
    isPrivateModeAvailableStatus(input.preview.claim_status) &&
    input.preview.selected_rail === "shielded_pool" &&
    (!evidenceChain?.proof_commitment ||
      !evidenceChain.witness_commitment ||
      !evidenceChain.relay_commitment ||
      !evidenceChain.finality_commitment)
  ) {
    throw new Error("private_mode_settlement_commitment_chain_required");
  }
  if (
    input.preview.connector_context &&
    (!evidenceChain?.manifest_commitment ||
      !evidenceChain.connector_readiness_commitment ||
      !evidenceChain.compiler_commitment ||
      !evidenceChain.linkability_score_commitment)
  ) {
    throw new Error("private_connector_commitment_chain_required");
  }
  if (
    input.preview.claim_status === "full_anonymity_available" &&
    input.preview.platform_class === "rfq_solver_network" &&
    input.preview.selected_rail === "shielded_batch_auction" &&
    (!evidenceChain?.work_order_commitment || !evidenceChain.connector_result_commitment)
  ) {
    throw new Error("full_anonymity_connector_result_required");
  }
  const zeroFrontRunEvidenceReady = Boolean(
    evidenceChain?.auction_epoch_commitment &&
      evidenceChain.auction_order_commitment &&
      evidenceChain.clearing_commitment &&
      evidenceChain.proof_commitment &&
      evidenceChain.finality_commitment &&
      evidenceChain.runtime_attestation_commitment &&
      evidenceChain.front_run_certificate_commitment === input.preview.front_run_certificate_commitment
  );
  if (
    input.preview.front_run_mode === "zero_front_run" &&
    (!input.preview.front_run_protection.zeroFrontRun ||
      !input.preview.front_run_certificate_commitment ||
      !zeroFrontRunEvidenceReady)
  ) {
    throw new Error("zero_front_run_certificate_required");
  }
  if (
    isPrivateModeAvailableStatus(input.preview.claim_status) &&
    (!evidenceChain?.runtime_envelope_commitment ||
      !evidenceChain.runtime_attestation_commitment ||
      !evidenceChain.runtime_health_commitment ||
      !evidenceChain.schedule_commitment ||
      !evidenceChain.rotation_commitment ||
      !evidenceChain.simulator_commitment ||
      PRIVATE_MODE_REQUIRED_CLAIM_LEVELS.some((level) => !input.preview.claim_levels_achieved.includes(level)))
  ) {
    throw new Error("private_mode_v6_commitment_chain_required");
  }
  return {
    ...unsigned,
    signature: signPrivateAccountReceipt(unsigned, input.secret || "ghola-dev-private-account-receipts"),
  };
}

export function isPrivateAccountRecordExpired(
  record: { expires_at: string },
  now: Date = new Date(),
): boolean {
  return new Date(record.expires_at).getTime() <= now.getTime();
}

export function assertPreviewMatchesIntent(
  preview: GholaPrivacyPreview,
  intent: GholaPrivateAccountIntentBinding,
): { ok: true } | { ok: false; error: "preview_mismatch" } {
  return preview.account_commitment === intent.account_commitment &&
    preview.action_commitment === intent.action_commitment
    ? { ok: true }
    : { ok: false, error: "preview_mismatch" };
}

export function assertApprovalMatchesPreview(
  approval: GholaPrivateAccountApprovalBinding,
  preview: GholaPrivacyPreview,
  intentId: string,
): { ok: true } | { ok: false; error: "approval_mismatch" } {
  return approval.preview_commitment === preview.preview_commitment &&
    approval.intent_id === intentId
    ? { ok: true }
    : { ok: false, error: "approval_mismatch" };
}

export function canApprovePreview(
  preview: GholaPrivacyPreview,
  degradedAccepted: boolean,
): { ok: true } | { ok: false; error: "blocked_leaky_path" | "degraded_acceptance_required" | "wait_for_anonymity" | "zero_front_run_certificate_required" } {
  if (preview.claim_status === "blocked_leaky_path") {
    return { ok: false, error: "blocked_leaky_path" };
  }
  if (preview.claim_status === "wait_for_anonymity") {
    return { ok: false, error: "wait_for_anonymity" };
  }
  if (preview.claim_status === "degraded_user_accepted_required" && !degradedAccepted) {
    return { ok: false, error: "degraded_acceptance_required" };
  }
  if (preview.front_run_mode === "zero_front_run" && !preview.front_run_protection.canLiveSubmitInZeroMode) {
    return { ok: false, error: "zero_front_run_certificate_required" };
  }
  return { ok: true };
}

export function isPrivateModeAvailableStatus(status: GholaClaimStatus): boolean {
  return status === "private_mode_available" || status === "full_anonymity_available";
}

export function canExecutePrivateAccountAction(input: {
  intent: GholaPrivateAccountIntentBinding;
  preview: GholaPrivacyPreview;
  approval: GholaPrivateAccountApprovalBinding;
  now?: Date;
}): {
  ok: true;
} | {
  ok: false;
  error:
    | "intent_expired"
    | "preview_expired"
    | "approval_expired"
    | "preview_mismatch"
    | "approval_mismatch"
    | "blocked_leaky_path"
    | "wait_for_anonymity"
    | "degraded_acceptance_required"
    | "zero_front_run_certificate_required";
} {
  const now = input.now ?? new Date();
  if (isPrivateAccountRecordExpired(input.intent, now)) return { ok: false, error: "intent_expired" };
  if (new Date(input.preview.expires_at).getTime() <= now.getTime()) return { ok: false, error: "preview_expired" };
  if (isPrivateAccountRecordExpired(input.approval, now)) return { ok: false, error: "approval_expired" };
  const previewMatch = assertPreviewMatchesIntent(input.preview, input.intent);
  if (!previewMatch.ok) return previewMatch;
  const approvalMatch = assertApprovalMatchesPreview(input.approval, input.preview, input.intent.intent_id);
  if (!approvalMatch.ok) return approvalMatch;
  return canApprovePreview(input.preview, input.approval.degraded_accepted);
}

export function containsForbiddenPublicPrivateAccountField(value: unknown): boolean {
  const forbidden = new Set([
    "raw_wallet_address",
    "wallet_address",
    "deposit_address",
    "provider_account_id",
    "email",
    "raw_holdings",
    "exact_balance",
    "raw_amount",
    "price",
    "order",
    "orders",
    "raw_order",
    "order_payload",
    "route",
    "quote",
    "signature_payload",
    "transaction",
    "raw_transaction",
    "signed_tx",
    "transaction_bytes",
    "withdraw_instruction_bytes",
    "instruction_data_hex",
    "recipient_address",
    "raw_recipient",
    "raw_destination",
    "proof_bundle",
    "proof",
    "raw_proof",
    "witness",
    "raw_witness",
    "witness_payload",
    "account_metas",
    "rpc_url",
    "api_key",
    "api_key_id",
    "api_key_name",
    "api_secret",
    "cdp_api_key",
    "coinbase_api_key",
    "coinbase_api_key_name",
    "coinbase_key_name",
    "coinbase_private_key",
    "coinbase_signing_key",
    "key_secret",
    "secret_key",
    "endpoint",
    "account_id",
    "account_uuid",
    "portfolio_id",
    "hyperliquid_account_id",
    "execution_account",
    "execution_account_id",
    "api_wallet",
    "api_wallet_address",
    "api_wallet_private_key",
    "raw_platform_payload",
    "liquidation_price",
    "leverage",
    "leverage_update",
    "vault_transfer",
    "private_key",
    "policy",
    "policy_commitment_seed",
    "policy_text",
    "prompt",
    "prompt_commitment_seed",
    "system_prompt",
    "strategy",
    "strategy_commitment_seed",
    "strategy_text",
    "session_token",
  ]);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsForbiddenPublicPrivateAccountField);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
    const normalized = key.toLowerCase();
    return forbidden.has(normalized) || containsForbiddenPublicPrivateAccountField(child);
  });
}

export function assertPublicSafePrivateAccountArtifact(
  value: unknown,
): { ok: true } | { ok: false; error: "forbidden_public_field" } {
  return containsForbiddenPublicPrivateAccountField(value)
    ? { ok: false, error: "forbidden_public_field" }
    : { ok: true };
}

export function createOmnibusAllocation(input: {
  account_commitment: string;
  pool_seed?: unknown;
  partner_seed?: unknown;
  settlement_funding_commitment?: string | null;
  utilization_bucket?: GholaOmnibusAllocation["utilization_bucket"];
  now?: Date;
}): GholaOmnibusAllocation {
  const now = input.now ?? new Date();
  const poolCommitment = gholaCommitment("omnibus_pool", input.pool_seed ?? "coinbase-partner-pool-v1");
  const partnerCommitment = gholaCommitment("omnibus_partner", input.partner_seed ?? "partner-held-coinbase-v1");
  const subledgerAccountCommitment = gholaCommitment("omnibus_subledger_account", {
    account_commitment: input.account_commitment,
    pool_commitment: poolCommitment,
    partner_commitment: partnerCommitment,
  });
  const seed = {
    account_commitment: input.account_commitment,
    pool_commitment: poolCommitment,
    partner_commitment: partnerCommitment,
    subledger_account_commitment: subledgerAccountCommitment,
    settlement_funding_commitment: input.settlement_funding_commitment ?? null,
    utilization_bucket: input.utilization_bucket ?? "0",
  };
  return {
    version: 1,
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: "partner_omnibus",
    account_commitment: input.account_commitment,
    pool_commitment: poolCommitment,
    partner_commitment: partnerCommitment,
    subledger_account_commitment: subledgerAccountCommitment,
    allocation_commitment: gholaCommitment("omnibus_allocation", seed),
    settlement_funding_commitment: input.settlement_funding_commitment ?? null,
    utilization_bucket: input.utilization_bucket ?? "0",
    status: input.settlement_funding_commitment ? "allocated" : "pending_funding",
    supported_operations: supportedVenueOperations("coinbase_advanced"),
    blocked_operations: blockedVenueOperations("coinbase_advanced", "partner_omnibus"),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

export function venuePlatformClass(venueId: GholaVenueId): GholaPlatformClass {
  if (venueId === "hyperliquid") return "hyperliquid_style_market";
  if (venueId === "phoenix" || venueId === "drift" || venueId === "backpack") return "solana_perps_market";
  if (venueId === "jupiter") return "solana_swap_aggregator";
  if (venueId === "rfq_network") return "rfq_solver_network";
  return "coinbase_style_provider";
}

export function venueIdForPlatformClass(platformClass: GholaPlatformClass): GholaVenueId | null {
  if (platformClass === "hyperliquid_style_market") return "hyperliquid";
  if (platformClass === "solana_perps_market") return "phoenix";
  if (platformClass === "solana_swap_aggregator") return "jupiter";
  if (platformClass === "coinbase_style_provider") return "coinbase_advanced";
  if (platformClass === "rfq_solver_network") return "rfq_network";
  return null;
}

export function supportedVenueOperations(venueId: GholaVenueId): GholaVenueOperationClass[] {
  if (venueId === "hyperliquid") return ["read", "limit_order", "cancel", "reconcile"];
  if (venueId === "phoenix" || venueId === "drift" || venueId === "backpack") {
    return ["read", "perp_limit_order", "cancel", "fills", "reconcile"];
  }
  if (venueId === "jupiter") return ["read", "preview_order", "swap", "reconcile"];
  if (venueId === "rfq_network") return ["read", "preview_order", "reconcile"];
  return ["read", "preview_order", "spot_limit_order", "spot_market_order", "cancel", "fills", "reconcile"];
}

export function blockedVenueOperations(
  venueId: GholaVenueId,
  executionMode: GholaVenueExecutionMode = "byo_api_key",
): GholaVenueBlockedOperation[] {
  const common: GholaVenueBlockedOperation[] = [
    "withdraw",
    "vault_transfer",
    "leverage_escalation",
  ];
  if (venueId === "hyperliquid") return common;
  if (venueId === "phoenix" || venueId === "drift" || venueId === "backpack") {
    return Array.from(new Set([
      ...common,
      "staking",
      "raw_custody_transfer",
      ...(executionMode === "ghola_pooled" ? [] : ["margin" as const]),
    ]));
  }
  if (venueId === "jupiter" || venueId === "rfq_network") {
    return Array.from(new Set([
      ...common,
      "margin",
      "futures",
      "staking",
      "raw_custody_transfer",
    ]));
  }
  return Array.from(new Set([
    ...common,
    "margin",
    "futures",
    "staking",
    "portfolio_mutation",
    "raw_custody_transfer",
    ...(executionMode === "partner_omnibus" ? ["vault_transfer" as const] : []),
  ]));
}

export function accountModeForExecutionMode(executionMode: GholaVenueExecutionMode): GholaVenueAccountMode {
  if (executionMode === "partner_omnibus" || executionMode === "ghola_pooled") return "ghola_pooled";
  if (
    executionMode === "managed_testnet" ||
    executionMode === "hyperliquid_native_vault" ||
    executionMode === "user_stealth"
  ) {
    return "user_stealth";
  }
  return "byo_account";
}

export function executionModeForAccountMode(accountMode: GholaVenueAccountMode): GholaVenueExecutionMode {
  if (accountMode === "ghola_pooled") return "ghola_pooled";
  if (accountMode === "user_stealth") return "user_stealth";
  return "byo_api_key";
}

export function listVenueManifests(now: Date = new Date()): GholaVenueManifest[] {
  return ([
    "hyperliquid",
    "phoenix",
    "drift",
    "jupiter",
    "backpack",
    "coinbase_advanced",
    "rfq_network",
  ] as GholaVenueId[]).map((venueId) => getVenueManifest(venueId, now));
}

export function getVenueManifest(venueId: GholaVenueId, now: Date = new Date()): GholaVenueManifest {
  const platformClass = venuePlatformClass(venueId);
  const profile = getPlatformPrivacyProfile(platformClass);
  const accountModes = supportedVenueAccountModes(venueId);
  const defaultAccountMode: GholaVenueAccountMode = accountModes.includes("user_stealth")
    ? "user_stealth"
    : accountModes[0] ?? "byo_account";
  const unsigned = {
    version: 1 as const,
    venue_id: venueId,
    platform_class: platformClass,
    label: venueLabel(venueId),
    supported_account_modes: accountModes,
    default_account_mode: defaultAccountMode,
    supported_actions: profile.supported_products,
    supported_operations: supportedVenueOperations(venueId),
    supported_rails: profile.privacy_runnable_rails,
    main_wallet_hidden_modes: accountModes.filter((mode) => mode !== "byo_account"),
    venue_account_hidden_modes: accountModes.includes("ghola_pooled") ? ["ghola_pooled" as const] : [],
    venue_sees: defaultVenueVisibility(venueId, defaultAccountMode),
    public_chain_sees: profile.public_chain_sees,
    minimum_anonymity_set: DEFAULT_ANONYMITY_SET_POLICY.consumer_min_effective_set,
    pilot_max_notional_bucket: "5" as const,
    blocked_operations: blockedVenueOperations(venueId, executionModeForAccountMode(defaultAccountMode)),
    expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
  };
  return {
    ...unsigned,
    manifest_commitment: gholaCommitment("venue_manifest", unsigned),
  };
}

export function createSecretHandle(input: {
  owner_commitment: string;
  account_commitment: string;
  venue_id: GholaVenueId;
  account_mode?: GholaVenueAccountMode;
  purpose?: GholaSecretHandle["purpose"];
  encrypted_secret_commitment: string;
  sealed_runtime_recipient_commitment: string;
  policy_seed?: unknown;
  rotation_epoch?: number;
  now?: Date;
}): GholaSecretHandle {
  const now = input.now ?? new Date();
  const platformClass = venuePlatformClass(input.venue_id);
  const accountMode = input.account_mode ?? "user_stealth";
  const policyCommitment = gholaCommitment("secret_handle_policy", {
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    venue_id: input.venue_id,
    account_mode: accountMode,
    purpose: input.purpose ?? "venue_account",
    seed: input.policy_seed ?? "ghola-secret-gravity-v1",
  });
  const seed = {
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    venue_id: input.venue_id,
    account_mode: accountMode,
    encrypted_secret_commitment: input.encrypted_secret_commitment,
    sealed_runtime_recipient_commitment: input.sealed_runtime_recipient_commitment,
    policy_commitment: policyCommitment,
    rotation_epoch: input.rotation_epoch ?? 0,
  };
  return {
    version: 1,
    secret_handle_commitment: gholaCommitment("secret_handle", seed),
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    venue_id: input.venue_id,
    platform_class: platformClass,
    account_mode: accountMode,
    purpose: input.purpose ?? "venue_account",
    sealed_runtime_recipient_commitment: input.sealed_runtime_recipient_commitment,
    encrypted_secret_commitment: input.encrypted_secret_commitment,
    policy_commitment: policyCommitment,
    rotation_epoch: input.rotation_epoch ?? 0,
    status: "sealed",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

export function createStealthVenueAccount(input: {
  account_commitment: string;
  venue_id: GholaVenueId;
  secret_handle_commitment: string;
  funding_evidence_commitment?: string | null;
  rotation_epoch?: number;
  now?: Date;
}): GholaStealthVenueAccount {
  const now = input.now ?? new Date();
  const platformClass = venuePlatformClass(input.venue_id);
  const rotationEpoch = input.rotation_epoch ?? 0;
  const seed = {
    account_commitment: input.account_commitment,
    venue_id: input.venue_id,
    secret_handle_commitment: input.secret_handle_commitment,
    funding_evidence_commitment: input.funding_evidence_commitment ?? null,
    rotation_epoch: rotationEpoch,
  };
  return {
    version: 1,
    venue_account_commitment: gholaCommitment("stealth_venue_account", seed),
    venue_id: input.venue_id,
    platform_class: platformClass,
    account_mode: "user_stealth",
    account_commitment: input.account_commitment,
    secret_handle_commitment: input.secret_handle_commitment,
    funding_evidence_commitment: input.funding_evidence_commitment ?? null,
    rotation_epoch_commitment: gholaCommitment("venue_rotation_epoch", {
      account_commitment: input.account_commitment,
      venue_id: input.venue_id,
      rotation_epoch: rotationEpoch,
    }),
    main_wallet_exposed: false,
    venue_account_visible_to_venue: true,
    status: input.funding_evidence_commitment ? "ready" : "funding_required",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

export function createPooledVenueAllocation(input: {
  account_commitment: string;
  venue_id: GholaVenueId;
  eligibility_commitment?: string | null;
  funding_evidence_commitment?: string | null;
  settlement_evidence_commitment?: string | null;
  utilization_bucket?: GholaPooledVenueAllocation["utilization_bucket"];
  pool_seed?: unknown;
  now?: Date;
}): GholaPooledVenueAllocation {
  const now = input.now ?? new Date();
  const platformClass = venuePlatformClass(input.venue_id);
  const poolCommitment = gholaCommitment("venue_pool", {
    venue_id: input.venue_id,
    platform_class: platformClass,
    seed: input.pool_seed ?? "ghola-pooled-venue-v1",
  });
  const seed = {
    account_commitment: input.account_commitment,
    venue_id: input.venue_id,
    pool_commitment: poolCommitment,
    eligibility_commitment: input.eligibility_commitment ?? null,
    funding_evidence_commitment: input.funding_evidence_commitment ?? null,
    settlement_evidence_commitment: input.settlement_evidence_commitment ?? null,
  };
  const poolShareCommitment = gholaCommitment("pooled_venue_pool_share", {
    account_commitment: input.account_commitment,
    venue_id: input.venue_id,
    pool_commitment: poolCommitment,
    eligibility_commitment: input.eligibility_commitment ?? null,
  });
  return {
    version: 1,
    pooled_allocation_commitment: gholaCommitment("pooled_venue_allocation", seed),
    venue_id: input.venue_id,
    platform_class: platformClass,
    account_mode: "ghola_pooled",
    account_commitment: input.account_commitment,
    pool_commitment: poolCommitment,
    pool_share_commitment: poolShareCommitment,
    subledger_account_commitment: gholaCommitment("pooled_venue_subledger", seed),
    eligibility_commitment: input.eligibility_commitment ?? null,
    funding_evidence_commitment: input.funding_evidence_commitment ?? null,
    settlement_evidence_commitment: input.settlement_evidence_commitment ?? null,
    utilization_bucket: input.utilization_bucket ?? "0",
    main_wallet_exposed: false,
    venue_account_visible_to_venue: false,
    status: input.eligibility_commitment || input.funding_evidence_commitment ? "allocated" : "pending_funding",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

export function createVenueEligibilityCredential(input: {
  owner_commitment: string;
  account_commitment: string;
  venue_id: GholaVenueId;
  credential_type?: GholaVenueEligibilityCredential["credential_type"];
  ttl_ms?: number;
  now?: Date;
}): GholaVenueEligibilityCredential {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + Math.max(60_000, input.ttl_ms ?? 30 * 24 * 60 * 60 * 1_000)).toISOString();
  const platformClass = venuePlatformClass(input.venue_id);
  const seed = {
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    venue_id: input.venue_id,
    platform_class: platformClass,
    credential_type: input.credential_type ?? "self_attested_eligible_user",
    credential_scope: "eligible_venue_access_only",
    expires_at: expiresAt,
  };
  return {
    version: 1,
    eligibility_commitment: gholaCommitment("venue_eligibility", seed),
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    venue_id: input.venue_id,
    platform_class: platformClass,
    credential_type: input.credential_type ?? "self_attested_eligible_user",
    credential_scope: "eligible_venue_access_only",
    status: "verified",
    expires_at: expiresAt,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

function supportedVenueAccountModes(venueId: GholaVenueId): GholaVenueAccountMode[] {
  if (venueId === "rfq_network") return ["ghola_pooled"];
  if (venueId === "jupiter") return ["user_stealth", "ghola_pooled"];
  return ["byo_account", "user_stealth", "ghola_pooled"];
}

function venueLabel(venueId: GholaVenueId): string {
  if (venueId === "hyperliquid") return "Hyperliquid";
  if (venueId === "phoenix") return "Phoenix";
  if (venueId === "drift") return "Drift";
  if (venueId === "jupiter") return "Jupiter";
  if (venueId === "backpack") return "Backpack";
  if (venueId === "coinbase_advanced") return "Coinbase Advanced";
  return "RFQ network";
}

function defaultVenueVisibility(
  venueId: GholaVenueId,
  accountMode: GholaVenueAccountMode,
): GholaVenueManifest["venue_sees"] {
  if (venueId === "rfq_network") return "none";
  if (accountMode === "ghola_pooled") return "pooled_account_and_order";
  if (accountMode === "user_stealth") return "stealth_account_and_order";
  return "user_account_and_order";
}

function profile(
  platformClass: GholaPlatformClass,
  label: string,
  products: GholaPrivateAccountActionClass[],
  publicChainSees: GholaPlatformPrivacyProfile["public_chain_sees"],
  platformSees: GholaPlatformPrivacyProfile["platform_sees"],
  gholaOperatorSees: GholaPlatformPrivacyProfile["ghola_operator_sees"],
  counterpartySees: GholaPlatformPrivacyProfile["counterparty_sees"],
  runnableRails: GholaRailKind[],
  degraded: string[],
  blocked: string[],
): GholaPlatformPrivacyProfile {
  return {
    version: 1,
    platform_class: platformClass,
    label,
    supported_products: products,
    public_chain_sees: publicChainSees,
    platform_sees: platformSees,
    ghola_operator_sees: gholaOperatorSees,
    counterparty_sees: counterpartySees,
    privacy_runnable_rails: runnableRails,
    degraded_conditions: degraded,
    blocked_conditions: blocked,
    connector_readiness_commitment: gholaCommitment("connector", { platformClass, runnableRails }),
  };
}

function bucketRank(value: string): number {
  const ordered = ["5", "10", "25", "50", "100"];
  const index = ordered.indexOf(value);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function selectRail(profile: GholaPlatformPrivacyProfile, requested?: GholaRailKind): GholaRailKind {
  if (requested) return requested;
  return ROUTING_ORDER.find((rail) => profile.privacy_runnable_rails.includes(rail)) || "direct_public_fallback";
}

function claimLevelsFor(input: {
  selectedRail: GholaRailKind;
  fullRail: boolean;
  anonymitySet: GholaAnonymitySetSummary;
  evidenceChain: GholaPrivateModeEvidenceChain | null;
  sealedRuntimeContext: GholaSealedRuntimeContext | null;
  claimStatus: GholaClaimStatus;
}): {
  achieved: GholaPrivateModeClaimLevel[];
  missing: GholaPrivateModeClaimLevel[];
  evidence: Partial<Record<GholaPrivateModeClaimLevel, string>>;
} {
  const achieved: GholaPrivateModeClaimLevel[] = [];
  const evidence: Partial<Record<GholaPrivateModeClaimLevel, string>> = {};
  if (input.selectedRail !== "direct_public_fallback") {
    achieved.push("source_wallet_hidden");
    evidence.source_wallet_hidden = input.evidenceChain?.funding_import_commitment ??
      input.sealedRuntimeContext?.runtime_envelope_commitment ??
      gholaCommitment("claim_source_wallet_hidden", input.selectedRail);
  }
  if (input.anonymitySet.amount_bucketed) {
    achieved.push("amount_bucketed");
    evidence.amount_bucketed = gholaCommitment("claim_amount_bucketed", input.anonymitySet);
  }
  if (input.evidenceChain?.batch_evidence_commitment) {
    achieved.push("batched_anonymity_set");
    evidence.batched_anonymity_set = input.evidenceChain.batch_evidence_commitment;
  }
  if (
    input.sealedRuntimeContext?.runtime_status === "ready" &&
    input.sealedRuntimeContext.runtime_attestation_commitment
  ) {
    achieved.push("operator_sealed");
    evidence.operator_sealed = input.sealedRuntimeContext.runtime_attestation_commitment;
  }
  if (isPrivateModeAvailableStatus(input.claimStatus) && input.fullRail) {
    achieved.push("selectively_disclosable");
    evidence.selectively_disclosable = input.sealedRuntimeContext?.runtime_envelope_commitment ??
      input.evidenceChain?.batch_evidence_commitment ??
      undefined;
  }
  const missing = PRIVATE_MODE_REQUIRED_CLAIM_LEVELS.filter((level) => !achieved.includes(level));
  return {
    achieved: Array.from(new Set(achieved)),
    missing,
    evidence,
  };
}

function anonymityLevelFor(input: {
  claimStatus: GholaClaimStatus;
  selectedRail: GholaRailKind;
  profile: GholaPlatformPrivacyProfile;
}): GholaAnonymityLevel {
  if (input.claimStatus === "blocked_leaky_path") return "P0_public";
  if (input.claimStatus === "full_anonymity_available") return "P5_selectively_disclosable";
  if (input.profile.platform_sees === "order_visible" || input.profile.platform_sees === "account_visible") return "P2_bucketed";
  if (isPrivateModeAvailableStatus(input.claimStatus)) return "P3_anonymity_set";
  if (input.selectedRail === "provider_omnibus_subaccount") return "P1_source_hidden";
  return "P2_bucketed";
}

function threatModelFor(profile: GholaPlatformPrivacyProfile): GholaThreatModel {
  const notPrivate: GholaThreatActor[] = [];
  if (profile.platform_sees === "order_visible" || profile.platform_sees === "account_visible") notPrivate.push("external_platform");
  if (profile.counterparty_sees !== "none") notPrivate.push("solver_or_counterparty");
  return {
    version: 1,
    private_against: ["public_chain_observer", "wallet_provider"],
    partially_private_against: ["rpc_provider", "relayer", "ghola_operator", "timing_observer", "colluding_platforms"],
    not_private_against: notPrivate,
  };
}

function buildLeakageMap(input: {
  actionCommitment: string;
  profile: GholaPlatformPrivacyProfile;
  selectedRail: GholaRailKind;
  claimStatus: GholaClaimStatus;
}): GholaLeakageMap {
  const publicVisible = input.selectedRail === "direct_public_fallback" || input.profile.public_chain_sees === "visible";
  const platformVisible = input.profile.platform_sees === "order_visible" || input.profile.platform_sees === "account_visible";
  const counterpartyVisible = input.profile.counterparty_sees !== "none";
  const channels: GholaLeakageMap["channels"] = {
    source_wallet_graph: input.selectedRail === "direct_public_fallback" ? "visible_on_public_chain" : "hidden_by_private_account",
    destination_wallet_graph: publicVisible ? "visible_on_public_chain" : "hidden_by_shielded_pool",
    platform_account_linkage: platformVisible ? "visible_to_platform" : "hidden_by_private_account",
    asset_visibility: publicVisible ? "visible_on_public_chain" : "minimized_by_bucket",
    amount_visibility: publicVisible ? "visible_on_public_chain" : "minimized_by_bucket",
    timing_urgency: "minimized_by_bucket",
    side_direction: platformVisible ? "visible_to_platform" : "hidden_by_private_account",
    quote_path: counterpartyVisible ? "visible_to_counterparty" : "hidden_by_private_account",
    counterparty_set: counterpartyVisible ? "visible_to_counterparty" : "hidden_by_private_account",
    solver_set: input.profile.platform_class === "rfq_solver_network" ? "visible_to_counterparty" : "hidden_by_private_account",
    settlement_linkage: publicVisible ? "visible_on_public_chain" : "hidden_by_vault_netting",
    cross_run_pattern: isPrivateModeAvailableStatus(input.claimStatus) ? "hidden_by_vault_netting" : "degraded_user_accepted",
  };
  return {
    version: 1,
    leakage_commitment: gholaCommitment("leakage", { action: input.actionCommitment, channels }),
    channels,
  };
}

function publicChainVisibility(
  profile: GholaPlatformPrivacyProfile,
  rail: GholaRailKind,
  claimStatus: GholaClaimStatus,
): GholaPrivacyPreview["public_chain_sees"] {
  if (claimStatus === "blocked_leaky_path") return "blocked";
  if (rail === "direct_public_fallback") return "visible";
  return profile.public_chain_sees;
}

function hiddenFrom(profile: GholaPlatformPrivacyProfile, rail: GholaRailKind): string[] {
  const hidden = ["main wallet graph"];
  if (rail !== "direct_public_fallback") hidden.push("public chain observers");
  if (profile.platform_sees === "none" || profile.platform_sees === "minimal") hidden.push("external platform account graph");
  return hidden;
}

function visibleTo(profile: GholaPlatformPrivacyProfile, rail: GholaRailKind): string[] {
  const visible: string[] = [];
  if (rail === "direct_public_fallback" || profile.public_chain_sees === "visible") visible.push("public chain");
  if (profile.platform_sees === "order_visible") visible.push("executing venue");
  if (profile.platform_sees === "account_visible") visible.push("custody/provider platform");
  if (profile.counterparty_sees !== "none") visible.push("counterparty or solver");
  return visible;
}

function signPrivateAccountReceipt(value: unknown, secret: string): string {
  return bytesToHex(hmac(sha256, new TextEncoder().encode(secret), new TextEncoder().encode(stablePrivateAccountJson(value))));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
