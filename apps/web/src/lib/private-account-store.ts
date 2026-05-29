import type {
  GholaCompiledPrivateIntent,
  GholaConnectorManifest,
  GholaConnectorResult,
  GholaConnectorWorkOrder,
  GholaLinkabilityScore,
} from "./private-account-connectors";
import type {
  GholaAdversarialLinkabilitySimulation,
  GholaPlatformFundingRotation,
  GholaPrivacyScheduleDecision,
} from "./private-account";
import type {
  GholaAuditorExportRevocation,
  GholaPrivateReceiptExport,
  GholaRuntimeEnvelope,
  GholaRuntimeHealth,
  GholaViewKey,
} from "./private-account-runtime";
import type {
  GholaAnonymitySetSummary,
  GholaAnonymityLevel,
  GholaAuctionClearingSummary,
  GholaAuctionLifecycleStatus,
  GholaAuctionOrderSide,
  GholaAuctionOrderSummary,
  GholaClaimStatus,
  GholaPlatformClass,
  GholaPrivateAccountActionClass,
  GholaPrivateExecutionAccount,
  GholaPrivacyBudget,
  GholaPrivateModeEvidenceChain,
  GholaPrivateAccountReceipt,
  GholaPrivateExecutionPlan,
  GholaHyperliquidExecutionVault,
  GholaHyperliquidManagedAllocation,
  GholaOmnibusAllocation,
  GholaPrivateModeCanaryKind,
  GholaPrivateSettlementLifecycleStatus,
  GholaPrivacyPreview,
  GholaRailKind,
  GholaShieldedSettlementEvidence,
  GholaPooledVenueAllocation,
  GholaSecretHandle,
  GholaStealthVenueAccount,
  GholaVenueExecutionVault,
} from "./private-account";

export type PrivateAccountIntentStatus =
  | "created"
  | "previewed"
  | "approved"
  | "executed"
  | "blocked"
  | "expired"
  | "cancelled";

export interface PrivateAccountIntentRecordV1 {
  version: 1;
  owner_commitment: string;
  intent_id: string;
  account_commitment: string;
  action_commitment: string;
  action_class: GholaPrivateAccountActionClass;
  product_bucket: string;
  policy_commitment: string;
  intent_commitment: string;
  status: PrivateAccountIntentStatus;
  created_at: string;
  expires_at: string;
}

export interface PrivateAccountPreviewRecordV1 {
  version: 1;
  owner_commitment: string;
  preview_commitment: string;
  intent_id: string;
  account_commitment: string;
  action_commitment: string;
  platform_class: GholaPlatformClass;
  selected_rail: GholaRailKind;
  claim_status: GholaClaimStatus;
  anonymity_level: GholaAnonymityLevel;
  preview: GholaPrivacyPreview;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface PrivateAccountApprovalRecordV1 {
  version: 1;
  owner_commitment: string;
  approval_commitment: string;
  preview_commitment: string;
  intent_id: string;
  execution_plan_commitment: string | null;
  degraded_accepted: boolean;
  approved_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface PrivateAccountExecutionRecordV1 {
  version: 1;
  owner_commitment: string;
  execution_commitment: string;
  intent_id: string;
  preview_commitment: string;
  approval_commitment: string;
  execution_plan_commitment: string | null;
  settlement_commitment: string | null;
  claim_status: GholaClaimStatus;
  rail_used: GholaRailKind;
  receipt_commitment: string;
  evidence_chain: GholaPrivateModeEvidenceChain | null;
  status: "executed" | "blocked";
  created_at: string;
}

export interface PrivateExecutionPlanRecordV1 {
  version: 1;
  owner_commitment: string;
  plan_commitment: string;
  intent_id: string;
  preview_commitment: string;
  account_commitment: string;
  action_commitment: string;
  status: GholaPrivateExecutionPlan["status"];
  selected_rail: GholaRailKind;
  plan: GholaPrivateExecutionPlan;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface PrivateSettlementRecordV1 {
  version: 1;
  owner_commitment: string;
  settlement_commitment: string;
  execution_commitment: string;
  plan_commitment: string;
  preview_commitment: string;
  approval_commitment: string;
  rail_used: GholaRailKind;
  lifecycle_status: GholaPrivateSettlementLifecycleStatus;
  root_commitment: string | null;
  witness_commitment: string | null;
  proof_commitment: string | null;
  relay_commitment: string | null;
  finality_commitment: string | null;
  attestation_commitment: string | null;
  failure_reason: string | null;
  evidence: GholaShieldedSettlementEvidence;
  created_at: string;
  updated_at: string;
}

export interface PrivateCoordinatorLockRecordV1 {
  version: 1;
  lock_id: string;
  run_window_commitment: string;
  acquired_at: string;
  expires_at: string;
}

export interface PrivateModeCanaryRecordV1 {
  version: 1;
  canary_id: string;
  canary_kind: GholaPrivateModeCanaryKind;
  status: "green" | "red";
  evidence_commitment: string | null;
  observed_at: string;
  expires_at: string;
  reason: string | null;
  created_at: string;
}

export interface PrivateConnectorManifestRecordV1 {
  version: 1;
  manifest_commitment: string;
  platform_class: GholaPlatformClass;
  manifest: GholaConnectorManifest;
  status: "current" | "stale" | "blocked";
  created_at: string;
  expires_at: string;
  updated_at: string;
}

export interface PrivateCompiledIntentRecordV1 {
  version: 1;
  compiler_commitment: string;
  owner_commitment: string;
  intent_id: string;
  account_commitment: string;
  action_commitment: string;
  platform_class: GholaPlatformClass;
  manifest_commitment: string;
  compiled_intent: GholaCompiledPrivateIntent;
  created_at: string;
}

export interface PrivateLinkabilityScoreRecordV1 {
  version: 1;
  score_commitment: string;
  owner_commitment: string;
  account_commitment: string;
  intent_id: string;
  platform_class: GholaPlatformClass;
  amount_bucket: string;
  asset_bucket: string;
  destination_class: string;
  score: GholaLinkabilityScore;
  created_at: string;
}

export interface PrivateConnectorWorkOrderRecordV1 {
  version: 1;
  work_order_commitment: string;
  owner_commitment: string;
  intent_id: string;
  account_commitment: string;
  action_commitment: string;
  preview_commitment: string;
  approval_commitment: string | null;
  execution_plan_commitment: string | null;
  platform_class: GholaPlatformClass;
  status: GholaConnectorWorkOrder["status"];
  work_order: GholaConnectorWorkOrder;
  created_at: string;
  updated_at: string;
}

export interface PrivateConnectorResultRecordV1 {
  version: 1;
  connector_result_commitment: string;
  work_order_commitment: string;
  owner_commitment: string;
  intent_id: string;
  platform_class: GholaPlatformClass;
  status: GholaConnectorResult["status"];
  result: GholaConnectorResult;
  created_at: string;
  updated_at: string;
}

export interface PrivateRuntimeEnvelopeRecordV1 {
  version: 1;
  runtime_envelope_commitment: string;
  owner_commitment: string;
  intent_id: string;
  account_commitment: string;
  action_commitment: string;
  platform_class: GholaPlatformClass;
  envelope: GholaRuntimeEnvelope;
  created_at: string;
  expires_at: string;
}

export interface PrivateScheduleDecisionRecordV1 {
  version: 1;
  schedule_commitment: string;
  owner_commitment: string;
  intent_id: string;
  preview_commitment: string | null;
  decision: GholaPrivacyScheduleDecision;
  created_at: string;
}

export interface PrivatePlatformRotationRecordV1 {
  version: 1;
  rotation_commitment: string;
  owner_commitment: string;
  account_commitment: string;
  platform_class: GholaPlatformClass;
  rotation: GholaPlatformFundingRotation;
  created_at: string;
}

export interface PrivateLinkabilitySimulationRecordV1 {
  version: 1;
  simulator_commitment: string;
  owner_commitment: string;
  intent_id: string;
  preview_commitment: string | null;
  simulation: GholaAdversarialLinkabilitySimulation;
  created_at: string;
}

export interface PrivateRuntimeHealthRecordV1 {
  version: 1;
  runtime_health_commitment: string;
  health: GholaRuntimeHealth;
  created_at: string;
}

export interface PrivateViewKeyRecordV1 {
  version: 1;
  view_key_commitment: string;
  owner_commitment: string;
  view_key: GholaViewKey;
  created_at: string;
  updated_at: string;
}

export interface PrivateReceiptExportRecordV1 {
  version: 1;
  private_export_commitment: string;
  owner_commitment: string;
  receipt_commitment: string;
  view_key_commitment: string;
  private_export: GholaPrivateReceiptExport;
  created_at: string;
  revoked_at: string | null;
}

export interface PrivateReceiptExportRevocationRecordV1 {
  version: 1;
  revocation_commitment: string;
  owner_commitment: string;
  private_export_commitment: string;
  view_key_commitment: string;
  revocation: GholaAuditorExportRevocation;
  revoked_at: string;
}

export interface PrivateAccountReceiptRecordV1 {
  version: 1;
  owner_commitment: string;
  receipt_commitment: string;
  intent_id: string;
  preview_commitment: string;
  approval_commitment: string;
  receipt: GholaPrivateAccountReceipt;
  created_at: string;
}

export interface PrivateAccountRecordV1 {
  version: 1;
  owner_commitment: string;
  account_commitment: string;
  session_commitment: string;
  turnkey_wallet_commitment: string;
  vault_root_commitment: string;
  note_root_commitment: string;
  nullifier_root_commitment: string;
  platform_link_root: string;
  policy_commitment: string;
  privacy_mode: "private_mode";
  claim_boundary: "engine_gated_full_anonymity";
  vault_ready: boolean;
  account: GholaPrivateExecutionAccount;
  created_at: string;
  updated_at: string;
}

export interface PrivateVaultStateRecordV1 {
  version: 1;
  owner_commitment: string;
  account_commitment: string;
  vault_root_commitment: string;
  note_root_commitment: string;
  nullifier_root_commitment: string;
  balance_bucket_summary: string[];
  ready_rails: GholaRailKind[];
  last_import_commitment: string | null;
  created_at: string;
  updated_at: string;
}

export interface PrivateHyperliquidVaultRecordV1 {
  version: 1;
  owner_commitment: string;
  account_commitment: string;
  vault_commitment: string;
  encrypted_vault_commitment: string;
  recipient_commitment: string;
  policy_commitment: string;
  status: GholaHyperliquidExecutionVault["status"];
  vault: GholaHyperliquidExecutionVault;
  created_at: string;
  updated_at: string;
}

export interface PrivateHyperliquidManagedAllocationRecordV1 {
  version: 1;
  owner_commitment: string;
  account_commitment: string;
  allocation_commitment: string;
  policy_commitment: string;
  pool_commitment: string;
  subledger_account_commitment: string;
  status: GholaHyperliquidManagedAllocation["status"];
  allocation: GholaHyperliquidManagedAllocation;
  created_at: string;
  updated_at: string;
}

export interface PrivateVenueExecutionVaultRecordV1 {
  version: 1;
  owner_commitment: string;
  account_commitment: string;
  venue_id: GholaVenueExecutionVault["venue_id"];
  platform_class: GholaVenueExecutionVault["platform_class"];
  execution_mode: GholaVenueExecutionVault["execution_mode"];
  vault_commitment: string;
  encrypted_vault_commitment: string;
  recipient_commitment: string;
  policy_commitment: string;
  allocation_commitment: string | null;
  status: GholaVenueExecutionVault["status"];
  vault: GholaVenueExecutionVault;
  created_at: string;
  updated_at: string;
}

export interface PrivateVenueSecretHandleRecordV1 {
  version: 1;
  secret_handle_commitment: string;
  owner_commitment: string;
  account_commitment: string;
  venue_id: GholaSecretHandle["venue_id"];
  platform_class: GholaSecretHandle["platform_class"];
  account_mode: GholaSecretHandle["account_mode"];
  purpose: GholaSecretHandle["purpose"];
  status: GholaSecretHandle["status"];
  secret_handle: GholaSecretHandle;
  created_at: string;
  updated_at: string;
}

export interface PrivateStealthVenueAccountRecordV1 {
  version: 1;
  venue_account_commitment: string;
  owner_commitment: string;
  account_commitment: string;
  venue_id: GholaStealthVenueAccount["venue_id"];
  platform_class: GholaStealthVenueAccount["platform_class"];
  secret_handle_commitment: string;
  status: GholaStealthVenueAccount["status"];
  venue_account: GholaStealthVenueAccount;
  created_at: string;
  updated_at: string;
}

export interface PrivatePooledVenueAllocationRecordV1 {
  version: 1;
  pooled_allocation_commitment: string;
  owner_commitment: string;
  account_commitment: string;
  venue_id: GholaPooledVenueAllocation["venue_id"];
  platform_class: GholaPooledVenueAllocation["platform_class"];
  pool_commitment: string;
  subledger_account_commitment: string;
  status: GholaPooledVenueAllocation["status"];
  allocation: GholaPooledVenueAllocation;
  created_at: string;
  updated_at: string;
}

export interface PrivateOmnibusAllocationRecordV1 {
  version: 1;
  owner_commitment: string;
  account_commitment: string;
  venue_id: GholaOmnibusAllocation["venue_id"];
  platform_class: GholaOmnibusAllocation["platform_class"];
  pool_commitment: string;
  partner_commitment: string;
  subledger_account_commitment: string;
  allocation_commitment: string;
  settlement_funding_commitment: string | null;
  utilization_bucket: GholaOmnibusAllocation["utilization_bucket"];
  status: GholaOmnibusAllocation["status"];
  allocation: GholaOmnibusAllocation;
  created_at: string;
  updated_at: string;
}

export interface PrivatePrivacyBudgetRecordV1 {
  version: 1;
  owner_commitment: string;
  account_commitment: string;
  budget: GholaPrivacyBudget;
  updated_at: string;
}

export interface PrivateQueuedActionRecordV1 {
  version: 1;
  queue_id: string;
  owner_commitment: string;
  account_commitment: string;
  intent_id: string;
  action_commitment: string;
  latest_preview_commitment: string;
  platform_class: GholaPlatformClass;
  requested_rail: GholaRailKind;
  wait_reasons: string[];
  target_anonymity_set: number;
  current_anonymity_set: number;
  status: "queued" | "ready" | "expired" | "cancelled" | "executed";
  created_at: string;
  expires_at: string;
  updated_at: string;
}

export interface PrivateAnonymityEvidenceRecordV1 {
  version: 1;
  evidence_commitment: string;
  owner_commitment: string;
  account_commitment: string;
  intent_id: string | null;
  action_commitment: string | null;
  queue_id: string | null;
  source:
    | "vault_indexer"
    | "batch_coordinator"
    | "solver_cohort"
    | "settlement_observer"
    | "internal_test";
  anonymity_set: GholaAnonymitySetSummary;
  created_at: string;
  updated_at: string;
}

export type PrivateFundingStatus = "pending" | "imported" | "expired" | "rejected";
export type PrivateFundingBatchStatus = "waiting" | "evidence_ready";
export type PrivateFundingRail = "custom_shielded_deposit";

export interface PrivateFundingInstructionRecordV1 {
  version: 1;
  funding_intent_id: string;
  owner_commitment: string;
  account_commitment: string;
  funding_intent_commitment: string;
  asset_bucket: string;
  amount_bucket: string;
  shielded_rail: PrivateFundingRail;
  destination_commitment: string;
  shielded_destination: string;
  status: PrivateFundingStatus;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

export interface PrivateFundingImportRecordV1 {
  version: 1;
  import_commitment: string;
  owner_commitment: string;
  account_commitment: string;
  funding_intent_id: string;
  funding_intent_commitment: string;
  receipt_commitment: string;
  nullifier_commitment: string;
  note_root_commitment: string;
  amount_bucket: string;
  asset_bucket: string;
  shielded_rail: PrivateFundingRail;
  verifier_status:
    | "verified"
    | "rejected"
    | "stale"
    | "insufficient_confirmations";
  verifier_commitment: string;
  verifier_observed_at: string;
  verifier_head_commitment: string;
  confirmation_depth: number;
  network: string;
  rejection_reason: string | null;
  imported_at: string;
}

export interface PrivateFundingBatchRecordV1 {
  version: 1;
  batch_id: string;
  owner_commitment: string;
  account_commitment: string;
  queue_id: string | null;
  action_commitment: string | null;
  selected_import_commitment: string | null;
  amount_bucket: string;
  asset_bucket: string;
  network: string;
  shielded_rail: PrivateFundingRail;
  import_commitments: string[];
  effective_anonymity_set: number;
  required_anonymity_set: number;
  timing_window_met: boolean;
  evidence_commitment: string | null;
  status: PrivateFundingBatchStatus;
  created_at: string;
  updated_at: string;
}

export interface PrivateFundingBatchRunRecordV1 {
  version: 1;
  run_id: string;
  coordinator_commitment: string;
  status: "healthy" | "waiting" | "unhealthy";
  accounts_scanned: number;
  queues_scanned: number;
  imports_scanned: number;
  batches_written: number;
  evidence_written: number;
  stale_imports: number;
  rejected_imports: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PrivateAuctionEpochRecordV1 {
  version: 1;
  owner_commitment: string;
  account_commitment: string;
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

export interface PrivateAuctionOrderRecordV1 {
  version: 1;
  owner_commitment: string;
  account_commitment: string;
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
  status: GholaAuctionOrderSummary["status"];
  created_at: string;
  updated_at: string;
}

export interface PrivateAuctionClearingRecordV1 {
  version: 1;
  owner_commitment: string;
  account_commitment: string;
  clearing_commitment: string;
  auction_epoch_commitment: string;
  status: GholaAuctionClearingSummary["status"];
  clearing_price_commitment: string;
  matched_order_commitments: string[];
  rolled_order_commitments: string[];
  proof_commitment: string;
  settlement_commitment: string | null;
  created_at: string;
  updated_at: string;
}

export type PrivateAuctionPreparedOperation =
  | "init_market"
  | "open_epoch"
  | "commit_order"
  | "close_epoch"
  | "settle_clearing";

export interface PrivateAuctionPreparedTransactionRecordV1 {
  version: 1;
  client_reference: string;
  owner_commitment: string;
  account_commitment: string;
  operation: PrivateAuctionPreparedOperation;
  transaction_base64: string;
  payload: Record<string, unknown>;
  status: "prepared" | "confirmed" | "expired" | "rejected";
  signature: string | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

type NeonSql = Awaited<
  ReturnType<typeof import("@neondatabase/serverless")["neon"]>
>;

type IntentRow = Omit<PrivateAccountIntentRecordV1, "version"> & { version?: number };
type PreviewRow = Omit<PrivateAccountPreviewRecordV1, "version" | "preview"> & {
  version?: number;
  preview: unknown;
};
type ApprovalRow = Omit<PrivateAccountApprovalRecordV1, "version"> & { version?: number };
type ExecutionRow = Omit<PrivateAccountExecutionRecordV1, "version" | "evidence_chain"> & {
  version?: number;
  evidence_chain?: unknown;
};
type ExecutionPlanRow = Omit<PrivateExecutionPlanRecordV1, "version" | "plan"> & {
  version?: number;
  plan: unknown;
};
type SettlementRow = Omit<PrivateSettlementRecordV1, "version" | "evidence"> & {
  version?: number;
  evidence: unknown;
};
type CoordinatorLockRow = Omit<PrivateCoordinatorLockRecordV1, "version"> & {
  version?: number;
};
type ModeCanaryRow = Omit<PrivateModeCanaryRecordV1, "version"> & {
  version?: number;
};
type ConnectorManifestRow = Omit<PrivateConnectorManifestRecordV1, "version" | "manifest"> & {
  version?: number;
  manifest: unknown;
};
type CompiledIntentRow = Omit<PrivateCompiledIntentRecordV1, "version" | "compiled_intent"> & {
  version?: number;
  compiled_intent: unknown;
};
type LinkabilityScoreRow = Omit<PrivateLinkabilityScoreRecordV1, "version" | "score"> & {
  version?: number;
  score: unknown;
};
type ConnectorWorkOrderRow = Omit<PrivateConnectorWorkOrderRecordV1, "version" | "work_order"> & {
  version?: number;
  work_order: unknown;
};
type ConnectorResultRow = Omit<PrivateConnectorResultRecordV1, "version" | "result"> & {
  version?: number;
  result: unknown;
};
type RuntimeEnvelopeRow = Omit<PrivateRuntimeEnvelopeRecordV1, "version" | "envelope"> & {
  version?: number;
  envelope: unknown;
};
type ScheduleDecisionRow = Omit<PrivateScheduleDecisionRecordV1, "version" | "decision"> & {
  version?: number;
  decision: unknown;
};
type PlatformRotationRow = Omit<PrivatePlatformRotationRecordV1, "version" | "rotation"> & {
  version?: number;
  rotation: unknown;
};
type LinkabilitySimulationRow = Omit<PrivateLinkabilitySimulationRecordV1, "version" | "simulation"> & {
  version?: number;
  simulation: unknown;
};
type ViewKeyRow = Omit<PrivateViewKeyRecordV1, "version" | "view_key"> & {
  version?: number;
  view_key: unknown;
};
type ReceiptExportRow = Omit<PrivateReceiptExportRecordV1, "version" | "private_export"> & {
  version?: number;
  private_export: unknown;
};
type ReceiptRow = Omit<PrivateAccountReceiptRecordV1, "version" | "receipt"> & {
  version?: number;
  receipt: unknown;
};
type AccountRow = Omit<PrivateAccountRecordV1, "version" | "account"> & {
  version?: number;
  account: unknown;
};
type VaultRow = Omit<PrivateVaultStateRecordV1, "version" | "balance_bucket_summary" | "ready_rails"> & {
  version?: number;
  balance_bucket_summary: unknown;
  ready_rails: unknown;
};
type HyperliquidVaultRow = Omit<PrivateHyperliquidVaultRecordV1, "version" | "vault"> & {
  version?: number;
  vault: unknown;
};
type HyperliquidManagedAllocationRow = Omit<PrivateHyperliquidManagedAllocationRecordV1, "version" | "allocation"> & {
  version?: number;
  allocation: unknown;
};
type VenueExecutionVaultRow = Omit<PrivateVenueExecutionVaultRecordV1, "version" | "vault"> & {
  version?: number;
  vault: unknown;
};
type VenueSecretHandleRow = Omit<PrivateVenueSecretHandleRecordV1, "version" | "secret_handle"> & {
  version?: number;
  secret_handle: unknown;
};
type StealthVenueAccountRow = Omit<PrivateStealthVenueAccountRecordV1, "version" | "venue_account"> & {
  version?: number;
  venue_account: unknown;
};
type PooledVenueAllocationRow = Omit<PrivatePooledVenueAllocationRecordV1, "version" | "allocation"> & {
  version?: number;
  allocation: unknown;
};
type OmnibusAllocationRow = Omit<PrivateOmnibusAllocationRecordV1, "version" | "allocation"> & {
  version?: number;
  allocation: unknown;
};
type BudgetRow = Omit<PrivatePrivacyBudgetRecordV1, "version" | "budget"> & {
  version?: number;
  budget: unknown;
};
type QueueRow = Omit<PrivateQueuedActionRecordV1, "version" | "wait_reasons"> & {
  version?: number;
  wait_reasons: unknown;
};
type AnonymityEvidenceRow = Omit<PrivateAnonymityEvidenceRecordV1, "version" | "anonymity_set"> & {
  version?: number;
  anonymity_set: unknown;
};
type FundingInstructionRow = Omit<PrivateFundingInstructionRecordV1, "version"> & {
  version?: number;
};
type FundingImportRow = Omit<PrivateFundingImportRecordV1, "version"> & {
  version?: number;
};
type FundingBatchRow = Omit<PrivateFundingBatchRecordV1, "version" | "import_commitments"> & {
  version?: number;
  import_commitments: unknown;
};
type FundingBatchRunRow = Omit<PrivateFundingBatchRunRecordV1, "version"> & {
  version?: number;
};
type AuctionEpochRow = Omit<PrivateAuctionEpochRecordV1, "version"> & {
  version?: number;
};
type AuctionOrderRow = Omit<PrivateAuctionOrderRecordV1, "version"> & {
  version?: number;
};
type AuctionClearingRow = Omit<PrivateAuctionClearingRecordV1, "version" | "matched_order_commitments" | "rolled_order_commitments"> & {
  version?: number;
  matched_order_commitments: unknown;
  rolled_order_commitments: unknown;
};
type AuctionPreparedTransactionRow = Omit<PrivateAuctionPreparedTransactionRecordV1, "version" | "payload"> & {
  version?: number;
  payload: unknown;
};

const intents = new Map<string, PrivateAccountIntentRecordV1>();
const previews = new Map<string, PrivateAccountPreviewRecordV1>();
const approvals = new Map<string, PrivateAccountApprovalRecordV1>();
const executions = new Map<string, PrivateAccountExecutionRecordV1>();
const executionPlans = new Map<string, PrivateExecutionPlanRecordV1>();
const settlements = new Map<string, PrivateSettlementRecordV1>();
const receipts = new Map<string, PrivateAccountReceiptRecordV1>();
const accounts = new Map<string, PrivateAccountRecordV1>();
const vaults = new Map<string, PrivateVaultStateRecordV1>();
const hyperliquidVaults = new Map<string, PrivateHyperliquidVaultRecordV1>();
const hyperliquidManagedAllocations = new Map<string, PrivateHyperliquidManagedAllocationRecordV1>();
const venueExecutionVaults = new Map<string, PrivateVenueExecutionVaultRecordV1>();
const venueSecretHandles = new Map<string, PrivateVenueSecretHandleRecordV1>();
const stealthVenueAccounts = new Map<string, PrivateStealthVenueAccountRecordV1>();
const pooledVenueAllocations = new Map<string, PrivatePooledVenueAllocationRecordV1>();
const omnibusAllocations = new Map<string, PrivateOmnibusAllocationRecordV1>();
const budgets = new Map<string, PrivatePrivacyBudgetRecordV1>();
const queuedActions = new Map<string, PrivateQueuedActionRecordV1>();
const anonymityEvidence = new Map<string, PrivateAnonymityEvidenceRecordV1>();
const fundingInstructions = new Map<string, PrivateFundingInstructionRecordV1>();
const fundingImports = new Map<string, PrivateFundingImportRecordV1>();
const fundingBatches = new Map<string, PrivateFundingBatchRecordV1>();
const fundingBatchRuns = new Map<string, PrivateFundingBatchRunRecordV1>();
const auctionEpochs = new Map<string, PrivateAuctionEpochRecordV1>();
const auctionOrders = new Map<string, PrivateAuctionOrderRecordV1>();
const auctionClearings = new Map<string, PrivateAuctionClearingRecordV1>();
const auctionPreparedTransactions = new Map<string, PrivateAuctionPreparedTransactionRecordV1>();
const coordinatorLocks = new Map<string, PrivateCoordinatorLockRecordV1>();
const modeCanaries = new Map<string, PrivateModeCanaryRecordV1>();
const connectorManifests = new Map<string, PrivateConnectorManifestRecordV1>();
const compiledIntents = new Map<string, PrivateCompiledIntentRecordV1>();
const linkabilityScores = new Map<string, PrivateLinkabilityScoreRecordV1>();
const connectorWorkOrders = new Map<string, PrivateConnectorWorkOrderRecordV1>();
const connectorResults = new Map<string, PrivateConnectorResultRecordV1>();
const runtimeEnvelopes = new Map<string, PrivateRuntimeEnvelopeRecordV1>();
const scheduleDecisions = new Map<string, PrivateScheduleDecisionRecordV1>();
const platformRotations = new Map<string, PrivatePlatformRotationRecordV1>();
const linkabilitySimulations = new Map<string, PrivateLinkabilitySimulationRecordV1>();
const runtimeHealthRecords = new Map<string, PrivateRuntimeHealthRecordV1>();
const viewKeys = new Map<string, PrivateViewKeyRecordV1>();
const receiptExports = new Map<string, PrivateReceiptExportRecordV1>();
const receiptExportRevocations = new Map<string, PrivateReceiptExportRevocationRecordV1>();

let sqlClient: NeonSql | null = null;
let schemaReady = false;

export async function putPrivateAccountRecord(
  record: PrivateAccountRecordV1,
): Promise<PrivateAccountRecordV1> {
  const sql = await getSql();
  if (!sql) {
    accounts.set(record.account_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_accounts (
      owner_commitment,
      account_commitment,
      session_commitment,
      turnkey_wallet_commitment,
      vault_root_commitment,
      note_root_commitment,
      nullifier_root_commitment,
      platform_link_root,
      policy_commitment,
      privacy_mode,
      claim_boundary,
      vault_ready,
      account,
      created_at,
      updated_at
    ) VALUES (
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.session_commitment},
      ${record.turnkey_wallet_commitment},
      ${record.vault_root_commitment},
      ${record.note_root_commitment},
      ${record.nullifier_root_commitment},
      ${record.platform_link_root},
      ${record.policy_commitment},
      ${record.privacy_mode},
      ${record.claim_boundary},
      ${record.vault_ready},
      ${JSON.stringify(record.account)}::jsonb,
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (account_commitment) DO UPDATE SET
      vault_ready = EXCLUDED.vault_ready,
      account = EXCLUDED.account,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getPrivateAccountByOwner(
  ownerCommitment: string,
): Promise<PrivateAccountRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(accounts.values()).find(
      (record) => record.owner_commitment === ownerCommitment,
    ) ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_accounts
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY created_at DESC
    LIMIT 1
  `) as AccountRow[];
  return rows[0] ? accountRow(rows[0]) : null;
}

export async function getPrivateAccountByCommitment(
  accountCommitment: string,
): Promise<PrivateAccountRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return accounts.get(accountCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_accounts
    WHERE account_commitment = ${accountCommitment}
    LIMIT 1
  `) as AccountRow[];
  return rows[0] ? accountRow(rows[0]) : null;
}

export async function putPrivateVaultState(
  record: PrivateVaultStateRecordV1,
): Promise<PrivateVaultStateRecordV1> {
  const sql = await getSql();
  if (!sql) {
    vaults.set(record.account_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_vaults (
      owner_commitment,
      account_commitment,
      vault_root_commitment,
      note_root_commitment,
      nullifier_root_commitment,
      balance_bucket_summary,
      ready_rails,
      last_import_commitment,
      created_at,
      updated_at
    ) VALUES (
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.vault_root_commitment},
      ${record.note_root_commitment},
      ${record.nullifier_root_commitment},
      ${JSON.stringify(record.balance_bucket_summary)}::jsonb,
      ${JSON.stringify(record.ready_rails)}::jsonb,
      ${record.last_import_commitment},
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (account_commitment) DO UPDATE SET
      balance_bucket_summary = EXCLUDED.balance_bucket_summary,
      ready_rails = EXCLUDED.ready_rails,
      last_import_commitment = EXCLUDED.last_import_commitment,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getPrivateVaultState(
  accountCommitment: string,
): Promise<PrivateVaultStateRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return vaults.get(accountCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_vaults
    WHERE account_commitment = ${accountCommitment}
    LIMIT 1
  `) as VaultRow[];
  return rows[0] ? vaultRow(rows[0]) : null;
}

export async function putHyperliquidExecutionVault(
  record: PrivateHyperliquidVaultRecordV1,
): Promise<PrivateHyperliquidVaultRecordV1> {
  const sql = await getSql();
  if (!sql) {
    hyperliquidVaults.set(record.vault_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_hyperliquid_vaults (
      vault_commitment,
      owner_commitment,
      account_commitment,
      encrypted_vault_commitment,
      recipient_commitment,
      policy_commitment,
      status,
      vault,
      created_at,
      updated_at
    ) VALUES (
      ${record.vault_commitment},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.encrypted_vault_commitment},
      ${record.recipient_commitment},
      ${record.policy_commitment},
      ${record.status},
      ${JSON.stringify(record.vault)}::jsonb,
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (vault_commitment) DO UPDATE SET
      status = EXCLUDED.status,
      vault = EXCLUDED.vault,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getHyperliquidExecutionVault(
  vaultCommitment: string,
): Promise<PrivateHyperliquidVaultRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return hyperliquidVaults.get(vaultCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_hyperliquid_vaults
    WHERE vault_commitment = ${vaultCommitment}
    LIMIT 1
  `) as HyperliquidVaultRow[];
  return rows[0] ? hyperliquidVaultRow(rows[0]) : null;
}

export async function getHyperliquidExecutionVaultByAccount(
  accountCommitment: string,
): Promise<PrivateHyperliquidVaultRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(hyperliquidVaults.values())
      .filter((record) => record.account_commitment === accountCommitment)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_hyperliquid_vaults
    WHERE account_commitment = ${accountCommitment}
    ORDER BY updated_at DESC
    LIMIT 1
  `) as HyperliquidVaultRow[];
  return rows[0] ? hyperliquidVaultRow(rows[0]) : null;
}

export async function putHyperliquidManagedAllocation(
  record: PrivateHyperliquidManagedAllocationRecordV1,
): Promise<PrivateHyperliquidManagedAllocationRecordV1> {
  const sql = await getSql();
  if (!sql) {
    hyperliquidManagedAllocations.set(record.allocation_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_hyperliquid_allocations (
      allocation_commitment,
      owner_commitment,
      account_commitment,
      policy_commitment,
      pool_commitment,
      subledger_account_commitment,
      status,
      allocation,
      created_at,
      updated_at
    ) VALUES (
      ${record.allocation_commitment},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.policy_commitment},
      ${record.pool_commitment},
      ${record.subledger_account_commitment},
      ${record.status},
      ${JSON.stringify(record.allocation)}::jsonb,
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (allocation_commitment) DO UPDATE SET
      status = EXCLUDED.status,
      allocation = EXCLUDED.allocation,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getHyperliquidManagedAllocation(
  allocationCommitment: string,
): Promise<PrivateHyperliquidManagedAllocationRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return hyperliquidManagedAllocations.get(allocationCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_hyperliquid_allocations
    WHERE allocation_commitment = ${allocationCommitment}
    LIMIT 1
  `) as HyperliquidManagedAllocationRow[];
  return rows[0] ? hyperliquidManagedAllocationRow(rows[0]) : null;
}

export async function getHyperliquidManagedAllocationByAccount(
  accountCommitment: string,
): Promise<PrivateHyperliquidManagedAllocationRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(hyperliquidManagedAllocations.values())
      .filter((record) => record.account_commitment === accountCommitment)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_hyperliquid_allocations
    WHERE account_commitment = ${accountCommitment}
    ORDER BY updated_at DESC
    LIMIT 1
  `) as HyperliquidManagedAllocationRow[];
  return rows[0] ? hyperliquidManagedAllocationRow(rows[0]) : null;
}

export async function putVenueExecutionVault(
  record: PrivateVenueExecutionVaultRecordV1,
): Promise<PrivateVenueExecutionVaultRecordV1> {
  const sql = await getSql();
  if (!sql) {
    venueExecutionVaults.set(record.vault_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_venue_vaults (
      vault_commitment,
      owner_commitment,
      account_commitment,
      venue_id,
      platform_class,
      execution_mode,
      encrypted_vault_commitment,
      recipient_commitment,
      policy_commitment,
      allocation_commitment,
      status,
      vault,
      created_at,
      updated_at
    ) VALUES (
      ${record.vault_commitment},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.venue_id},
      ${record.platform_class},
      ${record.execution_mode},
      ${record.encrypted_vault_commitment},
      ${record.recipient_commitment},
      ${record.policy_commitment},
      ${record.allocation_commitment},
      ${record.status},
      ${JSON.stringify(record.vault)}::jsonb,
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (vault_commitment) DO UPDATE SET
      status = EXCLUDED.status,
      allocation_commitment = EXCLUDED.allocation_commitment,
      vault = EXCLUDED.vault,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getVenueExecutionVault(
  vaultCommitment: string,
): Promise<PrivateVenueExecutionVaultRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return venueExecutionVaults.get(vaultCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_venue_vaults
    WHERE vault_commitment = ${vaultCommitment}
    LIMIT 1
  `) as VenueExecutionVaultRow[];
  return rows[0] ? venueExecutionVaultRow(rows[0]) : null;
}

export async function getVenueExecutionVaultByAccount(input: {
  account_commitment: string;
  venue_id?: GholaVenueExecutionVault["venue_id"] | null;
  execution_mode?: GholaVenueExecutionVault["execution_mode"] | null;
}): Promise<PrivateVenueExecutionVaultRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(venueExecutionVaults.values())
      .filter((record) =>
        record.account_commitment === input.account_commitment &&
        (!input.venue_id || record.venue_id === input.venue_id) &&
        (!input.execution_mode || record.execution_mode === input.execution_mode)
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = input.venue_id && input.execution_mode
    ? (await sql`
        SELECT * FROM private_account_venue_vaults
        WHERE account_commitment = ${input.account_commitment}
          AND venue_id = ${input.venue_id}
          AND execution_mode = ${input.execution_mode}
        ORDER BY updated_at DESC
        LIMIT 1
      `) as VenueExecutionVaultRow[]
    : input.venue_id
      ? (await sql`
          SELECT * FROM private_account_venue_vaults
          WHERE account_commitment = ${input.account_commitment}
            AND venue_id = ${input.venue_id}
          ORDER BY updated_at DESC
          LIMIT 1
        `) as VenueExecutionVaultRow[]
      : (await sql`
          SELECT * FROM private_account_venue_vaults
          WHERE account_commitment = ${input.account_commitment}
          ORDER BY updated_at DESC
          LIMIT 1
        `) as VenueExecutionVaultRow[];
  return rows[0] ? venueExecutionVaultRow(rows[0]) : null;
}

export async function putVenueSecretHandle(
  record: PrivateVenueSecretHandleRecordV1,
): Promise<PrivateVenueSecretHandleRecordV1> {
  const sql = await getSql();
  if (!sql) {
    venueSecretHandles.set(record.secret_handle_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_venue_secret_handles (
      secret_handle_commitment,
      owner_commitment,
      account_commitment,
      venue_id,
      platform_class,
      account_mode,
      purpose,
      status,
      secret_handle,
      created_at,
      updated_at
    ) VALUES (
      ${record.secret_handle_commitment},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.venue_id},
      ${record.platform_class},
      ${record.account_mode},
      ${record.purpose},
      ${record.status},
      ${JSON.stringify(record.secret_handle)}::jsonb,
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (secret_handle_commitment) DO UPDATE SET
      status = EXCLUDED.status,
      secret_handle = EXCLUDED.secret_handle,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getVenueSecretHandle(
  secretHandleCommitment: string,
): Promise<PrivateVenueSecretHandleRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return venueSecretHandles.get(secretHandleCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_venue_secret_handles
    WHERE secret_handle_commitment = ${secretHandleCommitment}
    LIMIT 1
  `) as VenueSecretHandleRow[];
  return rows[0] ? venueSecretHandleRow(rows[0]) : null;
}

export async function getLatestVenueSecretHandleByAccount(input: {
  account_commitment: string;
  venue_id: GholaSecretHandle["venue_id"];
  account_mode?: GholaSecretHandle["account_mode"] | null;
}): Promise<PrivateVenueSecretHandleRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(venueSecretHandles.values())
      .filter((record) =>
        record.account_commitment === input.account_commitment &&
        record.venue_id === input.venue_id &&
        (!input.account_mode || record.account_mode === input.account_mode)
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = input.account_mode
    ? (await sql`
        SELECT * FROM private_account_venue_secret_handles
        WHERE account_commitment = ${input.account_commitment}
          AND venue_id = ${input.venue_id}
          AND account_mode = ${input.account_mode}
        ORDER BY updated_at DESC
        LIMIT 1
      `) as VenueSecretHandleRow[]
    : (await sql`
        SELECT * FROM private_account_venue_secret_handles
        WHERE account_commitment = ${input.account_commitment}
          AND venue_id = ${input.venue_id}
        ORDER BY updated_at DESC
        LIMIT 1
      `) as VenueSecretHandleRow[];
  return rows[0] ? venueSecretHandleRow(rows[0]) : null;
}

export async function putStealthVenueAccount(
  record: PrivateStealthVenueAccountRecordV1,
): Promise<PrivateStealthVenueAccountRecordV1> {
  const sql = await getSql();
  if (!sql) {
    stealthVenueAccounts.set(record.venue_account_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_stealth_venue_accounts (
      venue_account_commitment,
      owner_commitment,
      account_commitment,
      venue_id,
      platform_class,
      secret_handle_commitment,
      status,
      venue_account,
      created_at,
      updated_at
    ) VALUES (
      ${record.venue_account_commitment},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.venue_id},
      ${record.platform_class},
      ${record.secret_handle_commitment},
      ${record.status},
      ${JSON.stringify(record.venue_account)}::jsonb,
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (venue_account_commitment) DO UPDATE SET
      status = EXCLUDED.status,
      venue_account = EXCLUDED.venue_account,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getLatestStealthVenueAccountByAccount(input: {
  account_commitment: string;
  venue_id: GholaStealthVenueAccount["venue_id"];
}): Promise<PrivateStealthVenueAccountRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(stealthVenueAccounts.values())
      .filter((record) =>
        record.account_commitment === input.account_commitment &&
        record.venue_id === input.venue_id
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_stealth_venue_accounts
    WHERE account_commitment = ${input.account_commitment}
      AND venue_id = ${input.venue_id}
    ORDER BY updated_at DESC
    LIMIT 1
  `) as StealthVenueAccountRow[];
  return rows[0] ? stealthVenueAccountRow(rows[0]) : null;
}

export async function putPooledVenueAllocation(
  record: PrivatePooledVenueAllocationRecordV1,
): Promise<PrivatePooledVenueAllocationRecordV1> {
  const sql = await getSql();
  if (!sql) {
    pooledVenueAllocations.set(record.pooled_allocation_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_pooled_venue_allocations (
      pooled_allocation_commitment,
      owner_commitment,
      account_commitment,
      venue_id,
      platform_class,
      pool_commitment,
      subledger_account_commitment,
      status,
      allocation,
      created_at,
      updated_at
    ) VALUES (
      ${record.pooled_allocation_commitment},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.venue_id},
      ${record.platform_class},
      ${record.pool_commitment},
      ${record.subledger_account_commitment},
      ${record.status},
      ${JSON.stringify(record.allocation)}::jsonb,
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (pooled_allocation_commitment) DO UPDATE SET
      status = EXCLUDED.status,
      allocation = EXCLUDED.allocation,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getLatestPooledVenueAllocationByAccount(input: {
  account_commitment: string;
  venue_id: GholaPooledVenueAllocation["venue_id"];
}): Promise<PrivatePooledVenueAllocationRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(pooledVenueAllocations.values())
      .filter((record) =>
        record.account_commitment === input.account_commitment &&
        record.venue_id === input.venue_id
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_pooled_venue_allocations
    WHERE account_commitment = ${input.account_commitment}
      AND venue_id = ${input.venue_id}
    ORDER BY updated_at DESC
    LIMIT 1
  `) as PooledVenueAllocationRow[];
  return rows[0] ? pooledVenueAllocationRow(rows[0]) : null;
}

export async function putOmnibusAllocation(
  record: PrivateOmnibusAllocationRecordV1,
): Promise<PrivateOmnibusAllocationRecordV1> {
  const sql = await getSql();
  if (!sql) {
    omnibusAllocations.set(record.allocation_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_omnibus_allocations (
      allocation_commitment,
      owner_commitment,
      account_commitment,
      venue_id,
      platform_class,
      pool_commitment,
      partner_commitment,
      subledger_account_commitment,
      settlement_funding_commitment,
      utilization_bucket,
      status,
      allocation,
      created_at,
      updated_at
    ) VALUES (
      ${record.allocation_commitment},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.venue_id},
      ${record.platform_class},
      ${record.pool_commitment},
      ${record.partner_commitment},
      ${record.subledger_account_commitment},
      ${record.settlement_funding_commitment},
      ${record.utilization_bucket},
      ${record.status},
      ${JSON.stringify(record.allocation)}::jsonb,
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (allocation_commitment) DO UPDATE SET
      settlement_funding_commitment = EXCLUDED.settlement_funding_commitment,
      utilization_bucket = EXCLUDED.utilization_bucket,
      status = EXCLUDED.status,
      allocation = EXCLUDED.allocation,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getOmnibusAllocation(
  allocationCommitment: string,
): Promise<PrivateOmnibusAllocationRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return omnibusAllocations.get(allocationCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_omnibus_allocations
    WHERE allocation_commitment = ${allocationCommitment}
    LIMIT 1
  `) as OmnibusAllocationRow[];
  return rows[0] ? omnibusAllocationRow(rows[0]) : null;
}

export async function getOmnibusAllocationByAccount(input: {
  account_commitment: string;
  venue_id?: GholaOmnibusAllocation["venue_id"] | null;
}): Promise<PrivateOmnibusAllocationRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(omnibusAllocations.values())
      .filter((record) =>
        record.account_commitment === input.account_commitment &&
        (!input.venue_id || record.venue_id === input.venue_id)
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = input.venue_id
    ? (await sql`
        SELECT * FROM private_account_omnibus_allocations
        WHERE account_commitment = ${input.account_commitment}
          AND venue_id = ${input.venue_id}
        ORDER BY updated_at DESC
        LIMIT 1
      `) as OmnibusAllocationRow[]
    : (await sql`
        SELECT * FROM private_account_omnibus_allocations
        WHERE account_commitment = ${input.account_commitment}
        ORDER BY updated_at DESC
        LIMIT 1
      `) as OmnibusAllocationRow[];
  return rows[0] ? omnibusAllocationRow(rows[0]) : null;
}

export async function listOmnibusAllocations(
  ownerCommitment: string,
  limit = 25,
): Promise<PrivateOmnibusAllocationRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(omnibusAllocations.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_omnibus_allocations
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY updated_at DESC
    LIMIT ${safeLimit}
  `) as OmnibusAllocationRow[];
  return rows.map(omnibusAllocationRow);
}

export async function putPrivacyBudget(
  record: PrivatePrivacyBudgetRecordV1,
): Promise<PrivatePrivacyBudgetRecordV1> {
  const sql = await getSql();
  if (!sql) {
    budgets.set(record.account_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_privacy_budgets (
      owner_commitment,
      account_commitment,
      budget,
      updated_at
    ) VALUES (
      ${record.owner_commitment},
      ${record.account_commitment},
      ${JSON.stringify(record.budget)}::jsonb,
      ${record.updated_at}
    )
    ON CONFLICT (account_commitment) DO UPDATE SET
      budget = EXCLUDED.budget,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getPrivacyBudget(
  accountCommitment: string,
): Promise<PrivatePrivacyBudgetRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return budgets.get(accountCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_privacy_budgets
    WHERE account_commitment = ${accountCommitment}
    LIMIT 1
  `) as BudgetRow[];
  return rows[0] ? budgetRow(rows[0]) : null;
}

export async function recordPrivacyBudgetEvent(input: {
  owner_commitment: string;
  account_commitment: string;
  degraded?: boolean;
  repeated_withdrawal?: boolean;
  repeated_cadence?: boolean;
}): Promise<PrivatePrivacyBudgetRecordV1> {
  const existing = await getPrivacyBudget(input.account_commitment);
  const budget = existing?.budget ?? defaultBudget();
  const next: PrivatePrivacyBudgetRecordV1 = {
    version: 1,
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    budget: {
      ...budget,
      degraded_action_count: budget.degraded_action_count + (input.degraded ? 1 : 0),
      repeated_withdrawal_count: budget.repeated_withdrawal_count + (input.repeated_withdrawal ? 1 : 0),
      repeated_cadence_count: budget.repeated_cadence_count + (input.repeated_cadence ? 1 : 0),
    },
    updated_at: new Date().toISOString(),
  };
  return putPrivacyBudget(next);
}

export async function putQueuedAction(
  record: PrivateQueuedActionRecordV1,
): Promise<PrivateQueuedActionRecordV1> {
  const sql = await getSql();
  if (!sql) {
    queuedActions.set(record.queue_id, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_action_queue (
      queue_id,
      owner_commitment,
      account_commitment,
      intent_id,
      action_commitment,
      latest_preview_commitment,
      platform_class,
      requested_rail,
      wait_reasons,
      target_anonymity_set,
      current_anonymity_set,
      status,
      created_at,
      expires_at,
      updated_at
    ) VALUES (
      ${record.queue_id},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.intent_id},
      ${record.action_commitment},
      ${record.latest_preview_commitment},
      ${record.platform_class},
      ${record.requested_rail},
      ${JSON.stringify(record.wait_reasons)}::jsonb,
      ${record.target_anonymity_set},
      ${record.current_anonymity_set},
      ${record.status},
      ${record.created_at},
      ${record.expires_at},
      ${record.updated_at}
    )
    ON CONFLICT (queue_id) DO UPDATE SET
      latest_preview_commitment = EXCLUDED.latest_preview_commitment,
      wait_reasons = EXCLUDED.wait_reasons,
      current_anonymity_set = EXCLUDED.current_anonymity_set,
      status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getQueuedAction(
  queueId: string,
): Promise<PrivateQueuedActionRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return queuedActions.get(queueId) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_action_queue
    WHERE queue_id = ${queueId}
    LIMIT 1
  `) as QueueRow[];
  return rows[0] ? queueRow(rows[0]) : null;
}

export async function listQueuedActions(
  ownerCommitment: string,
  limit = 25,
): Promise<PrivateQueuedActionRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(queuedActions.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_action_queue
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `) as QueueRow[];
  return rows.map(queueRow);
}

export async function listAllQueuedActions(
  limit = 250,
): Promise<PrivateQueuedActionRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(queuedActions.values())
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_action_queue
    ORDER BY updated_at DESC
    LIMIT ${safeLimit}
  `) as QueueRow[];
  return rows.map(queueRow);
}

export async function updateQueuedActionStatus(
  queueId: string,
  status: PrivateQueuedActionRecordV1["status"],
): Promise<void> {
  const existing = await getQueuedAction(queueId);
  if (!existing) return;
  await putQueuedAction({ ...existing, status, updated_at: new Date().toISOString() });
}

export async function putAnonymityEvidence(
  record: PrivateAnonymityEvidenceRecordV1,
): Promise<PrivateAnonymityEvidenceRecordV1> {
  const sql = await getSql();
  if (!sql) {
    anonymityEvidence.set(record.evidence_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_anonymity_evidence (
      evidence_commitment,
      owner_commitment,
      account_commitment,
      intent_id,
      action_commitment,
      queue_id,
      source,
      anonymity_set,
      created_at,
      updated_at
    ) VALUES (
      ${record.evidence_commitment},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.intent_id},
      ${record.action_commitment},
      ${record.queue_id},
      ${record.source},
      ${JSON.stringify(record.anonymity_set)}::jsonb,
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (evidence_commitment) DO UPDATE SET
      anonymity_set = EXCLUDED.anonymity_set,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getLatestAnonymityEvidence(input: {
  account_commitment: string;
  action_commitment?: string | null;
  queue_id?: string | null;
}): Promise<PrivateAnonymityEvidenceRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(anonymityEvidence.values())
      .filter((record) => {
        if (record.account_commitment !== input.account_commitment) return false;
        if (input.queue_id) return record.queue_id === input.queue_id;
        if (input.action_commitment) return record.action_commitment === input.action_commitment;
        return true;
      })
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = input.queue_id
    ? (await sql`
        SELECT * FROM private_account_anonymity_evidence
        WHERE account_commitment = ${input.account_commitment}
          AND queue_id = ${input.queue_id}
        ORDER BY updated_at DESC
        LIMIT 1
      `) as AnonymityEvidenceRow[]
    : input.action_commitment
      ? (await sql`
          SELECT * FROM private_account_anonymity_evidence
          WHERE account_commitment = ${input.account_commitment}
            AND action_commitment = ${input.action_commitment}
          ORDER BY updated_at DESC
          LIMIT 1
        `) as AnonymityEvidenceRow[]
      : (await sql`
          SELECT * FROM private_account_anonymity_evidence
          WHERE account_commitment = ${input.account_commitment}
          ORDER BY updated_at DESC
          LIMIT 1
        `) as AnonymityEvidenceRow[];
  return rows[0] ? anonymityEvidenceRow(rows[0]) : null;
}

export async function putPrivateFundingInstruction(
  record: PrivateFundingInstructionRecordV1,
): Promise<PrivateFundingInstructionRecordV1> {
  const sql = await getSql();
  if (!sql) {
    fundingInstructions.set(record.funding_intent_id, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_funding_instructions (
      funding_intent_id,
      owner_commitment,
      account_commitment,
      funding_intent_commitment,
      asset_bucket,
      amount_bucket,
      shielded_rail,
      destination_commitment,
      shielded_destination,
      status,
      created_at,
      expires_at,
      updated_at
    ) VALUES (
      ${record.funding_intent_id},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.funding_intent_commitment},
      ${record.asset_bucket},
      ${record.amount_bucket},
      ${record.shielded_rail},
      ${record.destination_commitment},
      ${record.shielded_destination},
      ${record.status},
      ${record.created_at},
      ${record.expires_at},
      ${record.updated_at}
    )
    ON CONFLICT (funding_intent_id) DO UPDATE SET
      status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getPrivateFundingInstruction(
  fundingIntentId: string,
): Promise<PrivateFundingInstructionRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return fundingInstructions.get(fundingIntentId) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_funding_instructions
    WHERE funding_intent_id = ${fundingIntentId}
    LIMIT 1
  `) as FundingInstructionRow[];
  return rows[0] ? fundingInstructionRow(rows[0]) : null;
}

export async function listPrivateFundingInstructions(
  ownerCommitment: string,
  limit = 10,
): Promise<PrivateFundingInstructionRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(fundingInstructions.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_funding_instructions
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `) as FundingInstructionRow[];
  return rows.map(fundingInstructionRow);
}

export async function putPrivateFundingImport(
  record: PrivateFundingImportRecordV1,
): Promise<PrivateFundingImportRecordV1> {
  const sql = await getSql();
  if (!sql) {
    fundingImports.set(record.import_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_funding_imports (
      import_commitment,
      owner_commitment,
      account_commitment,
      funding_intent_id,
      funding_intent_commitment,
      receipt_commitment,
      nullifier_commitment,
      note_root_commitment,
      amount_bucket,
      asset_bucket,
      shielded_rail,
      verifier_status,
      verifier_commitment,
      verifier_observed_at,
      verifier_head_commitment,
      confirmation_depth,
      network,
      rejection_reason,
      imported_at
    ) VALUES (
      ${record.import_commitment},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.funding_intent_id},
      ${record.funding_intent_commitment},
      ${record.receipt_commitment},
      ${record.nullifier_commitment},
      ${record.note_root_commitment},
      ${record.amount_bucket},
      ${record.asset_bucket},
      ${record.shielded_rail},
      ${record.verifier_status},
      ${record.verifier_commitment},
      ${record.verifier_observed_at},
      ${record.verifier_head_commitment},
      ${record.confirmation_depth},
      ${record.network},
      ${record.rejection_reason},
      ${record.imported_at}
    )
    ON CONFLICT (import_commitment) DO NOTHING
  `;
  return record;
}

export async function getPrivateFundingImportByNullifier(
  nullifierCommitment: string,
): Promise<PrivateFundingImportRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(fundingImports.values()).find(
      (record) => record.nullifier_commitment === nullifierCommitment,
    ) ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_funding_imports
    WHERE nullifier_commitment = ${nullifierCommitment}
    LIMIT 1
  `) as FundingImportRow[];
  return rows[0] ? fundingImportRow(rows[0]) : null;
}

export async function listPrivateFundingImports(
  ownerCommitment: string,
  limit = 20,
): Promise<PrivateFundingImportRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(fundingImports.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.imported_at.localeCompare(a.imported_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_funding_imports
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY imported_at DESC
    LIMIT ${safeLimit}
  `) as FundingImportRow[];
  return rows.map(fundingImportRow);
}

export async function listAllPrivateFundingImports(
  limit = 1_000,
): Promise<PrivateFundingImportRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(fundingImports.values())
      .sort((a, b) => b.imported_at.localeCompare(a.imported_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_funding_imports
    ORDER BY imported_at DESC
    LIMIT ${safeLimit}
  `) as FundingImportRow[];
  return rows.map(fundingImportRow);
}

export async function listCompatibleFundingImports(input: {
  asset_bucket: string;
  amount_bucket: string;
  shielded_rail: PrivateFundingRail;
  limit?: number;
}): Promise<PrivateFundingImportRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(fundingImports.values())
      .filter((record) =>
        record.asset_bucket === input.asset_bucket &&
        record.amount_bucket === input.amount_bucket &&
        record.shielded_rail === input.shielded_rail &&
        record.verifier_status === "verified"
      )
      .sort((a, b) => b.imported_at.localeCompare(a.imported_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_funding_imports
    WHERE asset_bucket = ${input.asset_bucket}
      AND amount_bucket = ${input.amount_bucket}
      AND shielded_rail = ${input.shielded_rail}
      AND verifier_status = 'verified'
    ORDER BY imported_at DESC
    LIMIT ${safeLimit}
  `) as FundingImportRow[];
  return rows.map(fundingImportRow);
}

export async function putPrivateFundingBatch(
  record: PrivateFundingBatchRecordV1,
): Promise<PrivateFundingBatchRecordV1> {
  const sql = await getSql();
  if (!sql) {
    fundingBatches.set(record.batch_id, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_funding_batches (
      batch_id,
      owner_commitment,
      account_commitment,
      queue_id,
      action_commitment,
      selected_import_commitment,
      amount_bucket,
      asset_bucket,
      network,
      shielded_rail,
      import_commitments,
      effective_anonymity_set,
      required_anonymity_set,
      timing_window_met,
      evidence_commitment,
      status,
      created_at,
      updated_at
    ) VALUES (
      ${record.batch_id},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.queue_id},
      ${record.action_commitment},
      ${record.selected_import_commitment},
      ${record.amount_bucket},
      ${record.asset_bucket},
      ${record.network},
      ${record.shielded_rail},
      ${JSON.stringify(record.import_commitments)}::jsonb,
      ${record.effective_anonymity_set},
      ${record.required_anonymity_set},
      ${record.timing_window_met},
      ${record.evidence_commitment},
      ${record.status},
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (batch_id) DO UPDATE SET
      import_commitments = EXCLUDED.import_commitments,
      effective_anonymity_set = EXCLUDED.effective_anonymity_set,
      timing_window_met = EXCLUDED.timing_window_met,
      evidence_commitment = EXCLUDED.evidence_commitment,
      status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getPrivateFundingBatchByEvidence(
  evidenceCommitment: string,
): Promise<PrivateFundingBatchRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(fundingBatches.values()).find(
      (record) => record.evidence_commitment === evidenceCommitment,
    ) ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_funding_batches
    WHERE evidence_commitment = ${evidenceCommitment}
    ORDER BY updated_at DESC
    LIMIT 1
  `) as FundingBatchRow[];
  return rows[0] ? fundingBatchRow(rows[0]) : null;
}

export async function listPrivateFundingBatches(
  ownerCommitment: string,
  limit = 10,
): Promise<PrivateFundingBatchRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(fundingBatches.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_funding_batches
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY updated_at DESC
    LIMIT ${safeLimit}
  `) as FundingBatchRow[];
  return rows.map(fundingBatchRow);
}

export async function putPrivateFundingBatchRun(
  record: PrivateFundingBatchRunRecordV1,
): Promise<PrivateFundingBatchRunRecordV1> {
  const sql = await getSql();
  if (!sql) {
    fundingBatchRuns.set(record.run_id, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_funding_batch_runs (
      run_id,
      coordinator_commitment,
      status,
      accounts_scanned,
      queues_scanned,
      imports_scanned,
      batches_written,
      evidence_written,
      stale_imports,
      rejected_imports,
      error,
      created_at,
      updated_at
    ) VALUES (
      ${record.run_id},
      ${record.coordinator_commitment},
      ${record.status},
      ${record.accounts_scanned},
      ${record.queues_scanned},
      ${record.imports_scanned},
      ${record.batches_written},
      ${record.evidence_written},
      ${record.stale_imports},
      ${record.rejected_imports},
      ${record.error},
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (run_id) DO UPDATE SET
      status = EXCLUDED.status,
      accounts_scanned = EXCLUDED.accounts_scanned,
      queues_scanned = EXCLUDED.queues_scanned,
      imports_scanned = EXCLUDED.imports_scanned,
      batches_written = EXCLUDED.batches_written,
      evidence_written = EXCLUDED.evidence_written,
      stale_imports = EXCLUDED.stale_imports,
      rejected_imports = EXCLUDED.rejected_imports,
      error = EXCLUDED.error,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getLatestPrivateFundingBatchRun(): Promise<PrivateFundingBatchRunRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(fundingBatchRuns.values())
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_funding_batch_runs
    ORDER BY updated_at DESC
    LIMIT 1
  `) as FundingBatchRunRow[];
  return rows[0] ? fundingBatchRunRow(rows[0]) : null;
}

export async function putPrivateAuctionEpoch(
  record: PrivateAuctionEpochRecordV1,
): Promise<PrivateAuctionEpochRecordV1> {
  const sql = await getSql();
  if (!sql) {
    auctionEpochs.set(record.auction_epoch_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_auction_epochs (
      auction_epoch_commitment,
      owner_commitment,
      account_commitment,
      market_commitment,
      platform_class,
      asset_bucket,
      amount_bucket,
      status,
      order_count,
      matched_count,
      rolled_count,
      opened_at,
      closes_at,
      updated_at
    ) VALUES (
      ${record.auction_epoch_commitment},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.market_commitment},
      ${record.platform_class},
      ${record.asset_bucket},
      ${record.amount_bucket},
      ${record.status},
      ${record.order_count},
      ${record.matched_count},
      ${record.rolled_count},
      ${record.opened_at},
      ${record.closes_at},
      ${record.updated_at}
    )
    ON CONFLICT (auction_epoch_commitment) DO UPDATE SET
      status = EXCLUDED.status,
      order_count = EXCLUDED.order_count,
      matched_count = EXCLUDED.matched_count,
      rolled_count = EXCLUDED.rolled_count,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getPrivateAuctionEpoch(
  auctionEpochCommitment: string,
): Promise<PrivateAuctionEpochRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return auctionEpochs.get(auctionEpochCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_auction_epochs
    WHERE auction_epoch_commitment = ${auctionEpochCommitment}
    LIMIT 1
  `) as AuctionEpochRow[];
  return rows[0] ? auctionEpochRow(rows[0]) : null;
}

export async function getOpenPrivateAuctionEpoch(input: {
  owner_commitment: string;
  platform_class: GholaPlatformClass;
  asset_bucket: string;
  amount_bucket: string;
  now: Date;
}): Promise<PrivateAuctionEpochRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(auctionEpochs.values())
      .filter((record) =>
        record.owner_commitment === input.owner_commitment &&
        record.platform_class === input.platform_class &&
        record.asset_bucket === input.asset_bucket &&
        record.amount_bucket === input.amount_bucket &&
        record.status === "open" &&
        new Date(record.closes_at).getTime() > input.now.getTime()
      )
      .sort((a, b) => b.opened_at.localeCompare(a.opened_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_auction_epochs
    WHERE owner_commitment = ${input.owner_commitment}
      AND platform_class = ${input.platform_class}
      AND asset_bucket = ${input.asset_bucket}
      AND amount_bucket = ${input.amount_bucket}
      AND status = 'open'
      AND closes_at > ${input.now.toISOString()}
    ORDER BY opened_at DESC
    LIMIT 1
  `) as AuctionEpochRow[];
  return rows[0] ? auctionEpochRow(rows[0]) : null;
}

export async function listPrivateAuctionEpochs(
  ownerCommitment: string,
  limit = 25,
): Promise<PrivateAuctionEpochRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(auctionEpochs.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_auction_epochs
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY updated_at DESC
    LIMIT ${safeLimit}
  `) as AuctionEpochRow[];
  return rows.map(auctionEpochRow);
}

export async function putPrivateAuctionOrder(
  record: PrivateAuctionOrderRecordV1,
): Promise<PrivateAuctionOrderRecordV1> {
  const sql = await getSql();
  if (!sql) {
    auctionOrders.set(record.auction_order_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_auction_orders (
      auction_order_commitment,
      owner_commitment,
      account_commitment,
      auction_epoch_commitment,
      queue_id,
      intent_id,
      action_commitment,
      action_class,
      platform_class,
      side,
      asset_bucket,
      amount_bucket,
      status,
      created_at,
      updated_at
    ) VALUES (
      ${record.auction_order_commitment},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.auction_epoch_commitment},
      ${record.queue_id},
      ${record.intent_id},
      ${record.action_commitment},
      ${record.action_class},
      ${record.platform_class},
      ${record.side},
      ${record.asset_bucket},
      ${record.amount_bucket},
      ${record.status},
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (auction_order_commitment) DO UPDATE SET
      status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getPrivateAuctionOrderByQueue(
  queueId: string,
): Promise<PrivateAuctionOrderRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(auctionOrders.values()).find((record) => record.queue_id === queueId) ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_auction_orders
    WHERE queue_id = ${queueId}
    ORDER BY updated_at DESC
    LIMIT 1
  `) as AuctionOrderRow[];
  return rows[0] ? auctionOrderRow(rows[0]) : null;
}

export async function listPrivateAuctionOrders(
  ownerCommitment: string,
  limit = 25,
): Promise<PrivateAuctionOrderRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(auctionOrders.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_auction_orders
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY updated_at DESC
    LIMIT ${safeLimit}
  `) as AuctionOrderRow[];
  return rows.map(auctionOrderRow);
}

export async function listPrivateAuctionOrdersByEpoch(
  auctionEpochCommitment: string,
): Promise<PrivateAuctionOrderRecordV1[]> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(auctionOrders.values())
      .filter((record) => record.auction_epoch_commitment === auctionEpochCommitment)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_auction_orders
    WHERE auction_epoch_commitment = ${auctionEpochCommitment}
    ORDER BY created_at ASC
  `) as AuctionOrderRow[];
  return rows.map(auctionOrderRow);
}

export async function putPrivateAuctionClearing(
  record: PrivateAuctionClearingRecordV1,
): Promise<PrivateAuctionClearingRecordV1> {
  const sql = await getSql();
  if (!sql) {
    auctionClearings.set(record.clearing_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_auction_clearings (
      clearing_commitment,
      owner_commitment,
      account_commitment,
      auction_epoch_commitment,
      status,
      clearing_price_commitment,
      matched_order_commitments,
      rolled_order_commitments,
      proof_commitment,
      settlement_commitment,
      created_at,
      updated_at
    ) VALUES (
      ${record.clearing_commitment},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.auction_epoch_commitment},
      ${record.status},
      ${record.clearing_price_commitment},
      ${JSON.stringify(record.matched_order_commitments)}::jsonb,
      ${JSON.stringify(record.rolled_order_commitments)}::jsonb,
      ${record.proof_commitment},
      ${record.settlement_commitment},
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (clearing_commitment) DO UPDATE SET
      status = EXCLUDED.status,
      settlement_commitment = EXCLUDED.settlement_commitment,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getPrivateAuctionClearing(
  clearingCommitment: string,
): Promise<PrivateAuctionClearingRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return auctionClearings.get(clearingCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_auction_clearings
    WHERE clearing_commitment = ${clearingCommitment}
    LIMIT 1
  `) as AuctionClearingRow[];
  return rows[0] ? auctionClearingRow(rows[0]) : null;
}

export async function getPrivateAuctionClearingByEpoch(
  auctionEpochCommitment: string,
): Promise<PrivateAuctionClearingRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(auctionClearings.values())
      .find((record) => record.auction_epoch_commitment === auctionEpochCommitment) ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_auction_clearings
    WHERE auction_epoch_commitment = ${auctionEpochCommitment}
    ORDER BY updated_at DESC
    LIMIT 1
  `) as AuctionClearingRow[];
  return rows[0] ? auctionClearingRow(rows[0]) : null;
}

export async function listPrivateAuctionClearings(
  ownerCommitment: string,
  limit = 25,
): Promise<PrivateAuctionClearingRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(auctionClearings.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_auction_clearings
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY updated_at DESC
    LIMIT ${safeLimit}
  `) as AuctionClearingRow[];
  return rows.map(auctionClearingRow);
}

export async function putPrivateAuctionPreparedTransaction(
  record: PrivateAuctionPreparedTransactionRecordV1,
): Promise<PrivateAuctionPreparedTransactionRecordV1> {
  const sql = await getSql();
  if (!sql) {
    auctionPreparedTransactions.set(record.client_reference, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_auction_prepared_transactions (
      client_reference,
      owner_commitment,
      account_commitment,
      operation,
      transaction_base64,
      payload,
      status,
      signature,
      created_at,
      expires_at,
      updated_at
    ) VALUES (
      ${record.client_reference},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.operation},
      ${record.transaction_base64},
      ${JSON.stringify(record.payload)}::jsonb,
      ${record.status},
      ${record.signature},
      ${record.created_at},
      ${record.expires_at},
      ${record.updated_at}
    )
    ON CONFLICT (client_reference) DO UPDATE SET
      transaction_base64 = EXCLUDED.transaction_base64,
      payload = EXCLUDED.payload,
      status = EXCLUDED.status,
      signature = EXCLUDED.signature,
      expires_at = EXCLUDED.expires_at,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getPrivateAuctionPreparedTransaction(
  clientReference: string,
): Promise<PrivateAuctionPreparedTransactionRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return auctionPreparedTransactions.get(clientReference) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_auction_prepared_transactions
    WHERE client_reference = ${clientReference}
    LIMIT 1
  `) as AuctionPreparedTransactionRow[];
  return rows[0] ? auctionPreparedTransactionRow(rows[0]) : null;
}

export async function acquirePrivateCoordinatorLock(input: {
  lock_id: string;
  run_window_commitment: string;
  now: Date;
  ttl_ms: number;
}): Promise<{ acquired: true; lock: PrivateCoordinatorLockRecordV1 } | { acquired: false; lock: PrivateCoordinatorLockRecordV1 }> {
  const expiresAt = new Date(input.now.getTime() + input.ttl_ms).toISOString();
  const existing = await getPrivateCoordinatorLock(input.lock_id);
  if (existing && new Date(existing.expires_at).getTime() > input.now.getTime()) {
    return { acquired: false, lock: existing };
  }
  const lock: PrivateCoordinatorLockRecordV1 = {
    version: 1,
    lock_id: input.lock_id,
    run_window_commitment: input.run_window_commitment,
    acquired_at: input.now.toISOString(),
    expires_at: expiresAt,
  };
  const sql = await getSql();
  if (!sql) {
    coordinatorLocks.set(lock.lock_id, lock);
    return { acquired: true, lock };
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_coordinator_locks (
      lock_id,
      run_window_commitment,
      acquired_at,
      expires_at
    ) VALUES (
      ${lock.lock_id},
      ${lock.run_window_commitment},
      ${lock.acquired_at},
      ${lock.expires_at}
    )
    ON CONFLICT (lock_id) DO UPDATE SET
      run_window_commitment = EXCLUDED.run_window_commitment,
      acquired_at = EXCLUDED.acquired_at,
      expires_at = EXCLUDED.expires_at
    WHERE private_account_coordinator_locks.expires_at <= ${input.now.toISOString()}
  `;
  const stored = await getPrivateCoordinatorLock(input.lock_id);
  return stored?.run_window_commitment === input.run_window_commitment
    ? { acquired: true, lock: stored }
    : { acquired: false, lock: stored ?? existing ?? lock };
}

export async function releasePrivateCoordinatorLock(
  lockId: string,
  runWindowCommitment: string,
): Promise<void> {
  const existing = await getPrivateCoordinatorLock(lockId);
  if (!existing || existing.run_window_commitment !== runWindowCommitment) return;
  const sql = await getSql();
  if (!sql) {
    coordinatorLocks.delete(lockId);
    return;
  }
  await ensureSchema(sql);
  await sql`
    DELETE FROM private_account_coordinator_locks
    WHERE lock_id = ${lockId} AND run_window_commitment = ${runWindowCommitment}
  `;
}

export async function getPrivateCoordinatorLock(
  lockId: string,
): Promise<PrivateCoordinatorLockRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return coordinatorLocks.get(lockId) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_coordinator_locks
    WHERE lock_id = ${lockId}
    LIMIT 1
  `) as CoordinatorLockRow[];
  return rows[0] ? coordinatorLockRow(rows[0]) : null;
}

export async function putPrivateAccountIntent(
  record: PrivateAccountIntentRecordV1,
): Promise<PrivateAccountIntentRecordV1> {
  const sql = await getSql();
  if (!sql) {
    intents.set(record.intent_id, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_intents (
      intent_id,
      owner_commitment,
      account_commitment,
      action_commitment,
      action_class,
      product_bucket,
      policy_commitment,
      intent_commitment,
      status,
      created_at,
      expires_at
    ) VALUES (
      ${record.intent_id},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.action_commitment},
      ${record.action_class},
      ${record.product_bucket},
      ${record.policy_commitment},
      ${record.intent_commitment},
      ${record.status},
      ${record.created_at},
      ${record.expires_at}
    )
    ON CONFLICT (intent_id) DO UPDATE SET
      status = EXCLUDED.status,
      expires_at = EXCLUDED.expires_at
  `;
  return record;
}

export async function getPrivateAccountIntent(
  intentId: string,
): Promise<PrivateAccountIntentRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return intents.get(intentId) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_intents WHERE intent_id = ${intentId} LIMIT 1
  `) as IntentRow[];
  return rows[0] ? intentRow(rows[0]) : null;
}

export async function updatePrivateAccountIntentStatus(
  intentId: string,
  status: PrivateAccountIntentStatus,
): Promise<void> {
  const existing = await getPrivateAccountIntent(intentId);
  if (!existing) return;
  const updated = { ...existing, status };
  const sql = await getSql();
  if (!sql) {
    intents.set(intentId, updated);
    return;
  }
  await ensureSchema(sql);
  await sql`
    UPDATE private_account_intents SET status = ${status}
    WHERE intent_id = ${intentId}
  `;
}

export async function putPrivateAccountPreview(
  record: PrivateAccountPreviewRecordV1,
): Promise<PrivateAccountPreviewRecordV1> {
  const sql = await getSql();
  if (!sql) {
    previews.set(record.preview_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_previews (
      preview_commitment,
      owner_commitment,
      intent_id,
      account_commitment,
      action_commitment,
      platform_class,
      selected_rail,
      claim_status,
      anonymity_level,
      preview,
      created_at,
      expires_at,
      consumed_at
    ) VALUES (
      ${record.preview_commitment},
      ${record.owner_commitment},
      ${record.intent_id},
      ${record.account_commitment},
      ${record.action_commitment},
      ${record.platform_class},
      ${record.selected_rail},
      ${record.claim_status},
      ${record.anonymity_level},
      ${JSON.stringify(record.preview)}::jsonb,
      ${record.created_at},
      ${record.expires_at},
      ${record.consumed_at}
    )
    ON CONFLICT (preview_commitment) DO UPDATE SET
      consumed_at = EXCLUDED.consumed_at
  `;
  return record;
}

export async function getPrivateAccountPreview(
  previewCommitment: string,
): Promise<PrivateAccountPreviewRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return previews.get(previewCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_previews
    WHERE preview_commitment = ${previewCommitment}
    LIMIT 1
  `) as PreviewRow[];
  return rows[0] ? previewRow(rows[0]) : null;
}

export async function consumePrivateAccountPreview(
  previewCommitment: string,
  consumedAt: string,
): Promise<void> {
  const existing = await getPrivateAccountPreview(previewCommitment);
  if (!existing) return;
  const updated = { ...existing, consumed_at: consumedAt };
  const sql = await getSql();
  if (!sql) {
    previews.set(previewCommitment, updated);
    return;
  }
  await ensureSchema(sql);
  await sql`
    UPDATE private_account_previews SET consumed_at = ${consumedAt}
    WHERE preview_commitment = ${previewCommitment} AND consumed_at IS NULL
  `;
}

export async function putPrivateAccountApproval(
  record: PrivateAccountApprovalRecordV1,
): Promise<PrivateAccountApprovalRecordV1> {
  const sql = await getSql();
  if (!sql) {
    approvals.set(record.approval_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_approvals (
      approval_commitment,
      owner_commitment,
      preview_commitment,
      intent_id,
      execution_plan_commitment,
      degraded_accepted,
      approved_at,
      expires_at,
      consumed_at
    ) VALUES (
      ${record.approval_commitment},
      ${record.owner_commitment},
      ${record.preview_commitment},
      ${record.intent_id},
      ${record.execution_plan_commitment},
      ${record.degraded_accepted},
      ${record.approved_at},
      ${record.expires_at},
      ${record.consumed_at}
    )
    ON CONFLICT (approval_commitment) DO UPDATE SET
      consumed_at = EXCLUDED.consumed_at
  `;
  return record;
}

export async function getPrivateAccountApproval(
  approvalCommitment: string,
): Promise<PrivateAccountApprovalRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return approvals.get(approvalCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_approvals
    WHERE approval_commitment = ${approvalCommitment}
    LIMIT 1
  `) as ApprovalRow[];
  return rows[0] ? approvalRow(rows[0]) : null;
}

export async function consumePrivateAccountApproval(
  approvalCommitment: string,
  consumedAt: string,
): Promise<void> {
  const existing = await getPrivateAccountApproval(approvalCommitment);
  if (!existing) return;
  const updated = { ...existing, consumed_at: consumedAt };
  const sql = await getSql();
  if (!sql) {
    approvals.set(approvalCommitment, updated);
    return;
  }
  await ensureSchema(sql);
  await sql`
    UPDATE private_account_approvals SET consumed_at = ${consumedAt}
    WHERE approval_commitment = ${approvalCommitment} AND consumed_at IS NULL
  `;
}

export async function putPrivateAccountExecution(
  record: PrivateAccountExecutionRecordV1,
): Promise<PrivateAccountExecutionRecordV1> {
  const sql = await getSql();
  if (!sql) {
    executions.set(record.execution_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_executions (
      execution_commitment,
      owner_commitment,
      intent_id,
      preview_commitment,
      approval_commitment,
      execution_plan_commitment,
      settlement_commitment,
      claim_status,
      rail_used,
      receipt_commitment,
      evidence_chain,
      status,
      created_at
    ) VALUES (
      ${record.execution_commitment},
      ${record.owner_commitment},
      ${record.intent_id},
      ${record.preview_commitment},
      ${record.approval_commitment},
      ${record.execution_plan_commitment},
      ${record.settlement_commitment},
      ${record.claim_status},
      ${record.rail_used},
      ${record.receipt_commitment},
      ${JSON.stringify(record.evidence_chain)}::jsonb,
      ${record.status},
      ${record.created_at}
    )
    ON CONFLICT (execution_commitment) DO NOTHING
  `;
  return record;
}

export async function getPrivateAccountExecutionByApproval(
  approvalCommitment: string,
): Promise<PrivateAccountExecutionRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(executions.values()).find(
      (record) => record.approval_commitment === approvalCommitment,
    ) ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_executions
    WHERE approval_commitment = ${approvalCommitment}
    LIMIT 1
  `) as ExecutionRow[];
  return rows[0] ? executionRow(rows[0]) : null;
}

export async function putPrivateExecutionPlan(
  record: PrivateExecutionPlanRecordV1,
): Promise<PrivateExecutionPlanRecordV1> {
  const sql = await getSql();
  if (!sql) {
    executionPlans.set(record.plan_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_execution_plans (
      plan_commitment,
      owner_commitment,
      intent_id,
      preview_commitment,
      account_commitment,
      action_commitment,
      status,
      selected_rail,
      plan,
      created_at,
      expires_at,
      consumed_at
    ) VALUES (
      ${record.plan_commitment},
      ${record.owner_commitment},
      ${record.intent_id},
      ${record.preview_commitment},
      ${record.account_commitment},
      ${record.action_commitment},
      ${record.status},
      ${record.selected_rail},
      ${JSON.stringify(record.plan)}::jsonb,
      ${record.created_at},
      ${record.expires_at},
      ${record.consumed_at}
    )
    ON CONFLICT (plan_commitment) DO UPDATE SET
      status = EXCLUDED.status,
      plan = EXCLUDED.plan,
      consumed_at = EXCLUDED.consumed_at
  `;
  return record;
}

export async function getPrivateExecutionPlan(
  planCommitment: string,
): Promise<PrivateExecutionPlanRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return executionPlans.get(planCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_execution_plans
    WHERE plan_commitment = ${planCommitment}
    LIMIT 1
  `) as ExecutionPlanRow[];
  return rows[0] ? executionPlanRow(rows[0]) : null;
}

export async function getPrivateExecutionPlanByPreview(
  previewCommitment: string,
): Promise<PrivateExecutionPlanRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(executionPlans.values()).find(
      (record) => record.preview_commitment === previewCommitment,
    ) ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_execution_plans
    WHERE preview_commitment = ${previewCommitment}
    ORDER BY created_at DESC
    LIMIT 1
  `) as ExecutionPlanRow[];
  return rows[0] ? executionPlanRow(rows[0]) : null;
}

export async function consumePrivateExecutionPlan(
  planCommitment: string,
  consumedAt: string,
): Promise<void> {
  const existing = await getPrivateExecutionPlan(planCommitment);
  if (!existing) return;
  const updated = { ...existing, consumed_at: consumedAt };
  const sql = await getSql();
  if (!sql) {
    executionPlans.set(planCommitment, updated);
    return;
  }
  await ensureSchema(sql);
  await sql`
    UPDATE private_account_execution_plans SET consumed_at = ${consumedAt}
    WHERE plan_commitment = ${planCommitment} AND consumed_at IS NULL
  `;
}

export async function putPrivateSettlement(
  record: PrivateSettlementRecordV1,
): Promise<PrivateSettlementRecordV1> {
  const sql = await getSql();
  if (!sql) {
    settlements.set(record.settlement_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_settlements (
      settlement_commitment,
      owner_commitment,
      execution_commitment,
      plan_commitment,
      preview_commitment,
      approval_commitment,
      rail_used,
      lifecycle_status,
      root_commitment,
      witness_commitment,
      proof_commitment,
      relay_commitment,
      finality_commitment,
      attestation_commitment,
      failure_reason,
      evidence,
      created_at,
      updated_at
    ) VALUES (
      ${record.settlement_commitment},
      ${record.owner_commitment},
      ${record.execution_commitment},
      ${record.plan_commitment},
      ${record.preview_commitment},
      ${record.approval_commitment},
      ${record.rail_used},
      ${record.lifecycle_status},
      ${record.root_commitment},
      ${record.witness_commitment},
      ${record.proof_commitment},
      ${record.relay_commitment},
      ${record.finality_commitment},
      ${record.attestation_commitment},
      ${record.failure_reason},
      ${JSON.stringify(record.evidence)}::jsonb,
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (settlement_commitment) DO UPDATE SET
      lifecycle_status = EXCLUDED.lifecycle_status,
      root_commitment = EXCLUDED.root_commitment,
      witness_commitment = EXCLUDED.witness_commitment,
      proof_commitment = EXCLUDED.proof_commitment,
      relay_commitment = EXCLUDED.relay_commitment,
      finality_commitment = EXCLUDED.finality_commitment,
      attestation_commitment = EXCLUDED.attestation_commitment,
      failure_reason = EXCLUDED.failure_reason,
      evidence = EXCLUDED.evidence,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getPrivateSettlement(
  settlementCommitment: string,
): Promise<PrivateSettlementRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return settlements.get(settlementCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_settlements
    WHERE settlement_commitment = ${settlementCommitment}
    LIMIT 1
  `) as SettlementRow[];
  return rows[0] ? settlementRow(rows[0]) : null;
}

export async function getPrivateSettlementByExecution(
  executionCommitment: string,
): Promise<PrivateSettlementRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(settlements.values()).find(
      (record) => record.execution_commitment === executionCommitment,
    ) ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_settlements
    WHERE execution_commitment = ${executionCommitment}
    LIMIT 1
  `) as SettlementRow[];
  return rows[0] ? settlementRow(rows[0]) : null;
}

export async function listPrivateSettlements(
  ownerCommitment: string,
  limit = 20,
): Promise<PrivateSettlementRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(settlements.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_settlements
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `) as SettlementRow[];
  return rows.map(settlementRow);
}

export async function putPrivateModeCanary(
  record: PrivateModeCanaryRecordV1,
): Promise<PrivateModeCanaryRecordV1> {
  const sql = await getSql();
  if (!sql) {
    modeCanaries.set(record.canary_id, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_mode_canaries (
      canary_id,
      canary_kind,
      status,
      evidence_commitment,
      observed_at,
      expires_at,
      reason,
      created_at
    ) VALUES (
      ${record.canary_id},
      ${record.canary_kind},
      ${record.status},
      ${record.evidence_commitment},
      ${record.observed_at},
      ${record.expires_at},
      ${record.reason},
      ${record.created_at}
    )
    ON CONFLICT (canary_id) DO UPDATE SET
      status = EXCLUDED.status,
      evidence_commitment = EXCLUDED.evidence_commitment,
      observed_at = EXCLUDED.observed_at,
      expires_at = EXCLUDED.expires_at,
      reason = EXCLUDED.reason
  `;
  return record;
}

export async function getLatestPrivateModeCanary(
  kind: GholaPrivateModeCanaryKind,
): Promise<PrivateModeCanaryRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(modeCanaries.values())
      .filter((record) => record.canary_kind === kind)
      .sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_mode_canaries
    WHERE canary_kind = ${kind}
    ORDER BY observed_at DESC
    LIMIT 1
  `) as ModeCanaryRow[];
  return rows[0] ? modeCanaryRow(rows[0]) : null;
}

export async function listPrivateModeCanaries(
  limit = 25,
): Promise<PrivateModeCanaryRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(modeCanaries.values())
      .sort((a, b) => b.observed_at.localeCompare(a.observed_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_mode_canaries
    ORDER BY observed_at DESC
    LIMIT ${safeLimit}
  `) as ModeCanaryRow[];
  return rows.map(modeCanaryRow);
}

export async function putConnectorManifest(
  record: PrivateConnectorManifestRecordV1,
): Promise<PrivateConnectorManifestRecordV1> {
  const sql = await getSql();
  if (!sql) {
    connectorManifests.set(record.manifest_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_connector_manifests (
      manifest_commitment,
      platform_class,
      manifest,
      status,
      created_at,
      expires_at,
      updated_at
    ) VALUES (
      ${record.manifest_commitment},
      ${record.platform_class},
      ${JSON.stringify(record.manifest)}::jsonb,
      ${record.status},
      ${record.created_at},
      ${record.expires_at},
      ${record.updated_at}
    )
    ON CONFLICT (manifest_commitment) DO UPDATE SET
      manifest = EXCLUDED.manifest,
      status = EXCLUDED.status,
      expires_at = EXCLUDED.expires_at,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getConnectorManifestRecord(
  manifestCommitment: string,
): Promise<PrivateConnectorManifestRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return connectorManifests.get(manifestCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_connector_manifests
    WHERE manifest_commitment = ${manifestCommitment}
    LIMIT 1
  `) as ConnectorManifestRow[];
  return rows[0] ? connectorManifestRow(rows[0]) : null;
}

export async function listConnectorManifestRecords(
  limit = 25,
): Promise<PrivateConnectorManifestRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(connectorManifests.values())
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_connector_manifests
    ORDER BY updated_at DESC
    LIMIT ${safeLimit}
  `) as ConnectorManifestRow[];
  return rows.map(connectorManifestRow);
}

export async function putCompiledIntent(
  record: PrivateCompiledIntentRecordV1,
): Promise<PrivateCompiledIntentRecordV1> {
  const sql = await getSql();
  if (!sql) {
    compiledIntents.set(record.compiler_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_compiled_intents (
      compiler_commitment,
      owner_commitment,
      intent_id,
      account_commitment,
      action_commitment,
      platform_class,
      manifest_commitment,
      compiled_intent,
      created_at
    ) VALUES (
      ${record.compiler_commitment},
      ${record.owner_commitment},
      ${record.intent_id},
      ${record.account_commitment},
      ${record.action_commitment},
      ${record.platform_class},
      ${record.manifest_commitment},
      ${JSON.stringify(record.compiled_intent)}::jsonb,
      ${record.created_at}
    )
    ON CONFLICT (compiler_commitment) DO NOTHING
  `;
  return record;
}

export async function getCompiledIntent(
  compilerCommitment: string,
): Promise<PrivateCompiledIntentRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return compiledIntents.get(compilerCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_compiled_intents
    WHERE compiler_commitment = ${compilerCommitment}
    LIMIT 1
  `) as CompiledIntentRow[];
  return rows[0] ? compiledIntentRow(rows[0]) : null;
}

export async function getCompiledIntentByIntent(
  intentId: string,
  platformClass?: GholaPlatformClass,
): Promise<PrivateCompiledIntentRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(compiledIntents.values())
      .filter((record) => record.intent_id === intentId && (!platformClass || record.platform_class === platformClass))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = platformClass
    ? (await sql`
        SELECT * FROM private_account_compiled_intents
        WHERE intent_id = ${intentId}
          AND platform_class = ${platformClass}
        ORDER BY created_at DESC
        LIMIT 1
      `) as CompiledIntentRow[]
    : (await sql`
        SELECT * FROM private_account_compiled_intents
        WHERE intent_id = ${intentId}
        ORDER BY created_at DESC
        LIMIT 1
      `) as CompiledIntentRow[];
  return rows[0] ? compiledIntentRow(rows[0]) : null;
}

export async function putLinkabilityScore(
  record: PrivateLinkabilityScoreRecordV1,
): Promise<PrivateLinkabilityScoreRecordV1> {
  const sql = await getSql();
  if (!sql) {
    linkabilityScores.set(record.score_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_linkability_scores (
      score_commitment,
      owner_commitment,
      account_commitment,
      intent_id,
      platform_class,
      amount_bucket,
      asset_bucket,
      destination_class,
      score,
      created_at
    ) VALUES (
      ${record.score_commitment},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.intent_id},
      ${record.platform_class},
      ${record.amount_bucket},
      ${record.asset_bucket},
      ${record.destination_class},
      ${JSON.stringify(record.score)}::jsonb,
      ${record.created_at}
    )
    ON CONFLICT (score_commitment) DO NOTHING
  `;
  return record;
}

export async function getLinkabilityScore(
  scoreCommitment: string,
): Promise<PrivateLinkabilityScoreRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return linkabilityScores.get(scoreCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_linkability_scores
    WHERE score_commitment = ${scoreCommitment}
    LIMIT 1
  `) as LinkabilityScoreRow[];
  return rows[0] ? linkabilityScoreRow(rows[0]) : null;
}

export async function listLinkabilityScores(
  ownerCommitment: string,
  limit = 100,
): Promise<PrivateLinkabilityScoreRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(linkabilityScores.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_linkability_scores
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `) as LinkabilityScoreRow[];
  return rows.map(linkabilityScoreRow);
}

export async function putConnectorWorkOrder(
  record: PrivateConnectorWorkOrderRecordV1,
): Promise<PrivateConnectorWorkOrderRecordV1> {
  const sql = await getSql();
  if (!sql) {
    connectorWorkOrders.set(record.work_order_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_connector_work_orders (
      work_order_commitment,
      owner_commitment,
      intent_id,
      account_commitment,
      action_commitment,
      preview_commitment,
      approval_commitment,
      execution_plan_commitment,
      platform_class,
      status,
      work_order,
      created_at,
      updated_at
    ) VALUES (
      ${record.work_order_commitment},
      ${record.owner_commitment},
      ${record.intent_id},
      ${record.account_commitment},
      ${record.action_commitment},
      ${record.preview_commitment},
      ${record.approval_commitment},
      ${record.execution_plan_commitment},
      ${record.platform_class},
      ${record.status},
      ${JSON.stringify(record.work_order)}::jsonb,
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (work_order_commitment) DO UPDATE SET
      approval_commitment = EXCLUDED.approval_commitment,
      execution_plan_commitment = EXCLUDED.execution_plan_commitment,
      status = EXCLUDED.status,
      work_order = EXCLUDED.work_order,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getConnectorWorkOrder(
  workOrderCommitment: string,
): Promise<PrivateConnectorWorkOrderRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return connectorWorkOrders.get(workOrderCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_connector_work_orders
    WHERE work_order_commitment = ${workOrderCommitment}
    LIMIT 1
  `) as ConnectorWorkOrderRow[];
  return rows[0] ? connectorWorkOrderRow(rows[0]) : null;
}

export async function getConnectorWorkOrderByPreview(
  previewCommitment: string,
): Promise<PrivateConnectorWorkOrderRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(connectorWorkOrders.values())
      .filter((record) => record.preview_commitment === previewCommitment)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_connector_work_orders
    WHERE preview_commitment = ${previewCommitment}
    ORDER BY updated_at DESC
    LIMIT 1
  `) as ConnectorWorkOrderRow[];
  return rows[0] ? connectorWorkOrderRow(rows[0]) : null;
}

export async function listConnectorWorkOrders(
  ownerCommitment: string,
  limit = 50,
): Promise<PrivateConnectorWorkOrderRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(connectorWorkOrders.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_connector_work_orders
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY updated_at DESC
    LIMIT ${safeLimit}
  `) as ConnectorWorkOrderRow[];
  return rows.map(connectorWorkOrderRow);
}

export async function putConnectorResult(
  record: PrivateConnectorResultRecordV1,
): Promise<PrivateConnectorResultRecordV1> {
  const sql = await getSql();
  if (!sql) {
    connectorResults.set(record.connector_result_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_connector_results (
      connector_result_commitment,
      work_order_commitment,
      owner_commitment,
      intent_id,
      platform_class,
      status,
      result,
      created_at,
      updated_at
    ) VALUES (
      ${record.connector_result_commitment},
      ${record.work_order_commitment},
      ${record.owner_commitment},
      ${record.intent_id},
      ${record.platform_class},
      ${record.status},
      ${JSON.stringify(record.result)}::jsonb,
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (connector_result_commitment) DO UPDATE SET
      status = EXCLUDED.status,
      result = EXCLUDED.result,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getConnectorResult(
  connectorResultCommitment: string,
): Promise<PrivateConnectorResultRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return connectorResults.get(connectorResultCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_connector_results
    WHERE connector_result_commitment = ${connectorResultCommitment}
    LIMIT 1
  `) as ConnectorResultRow[];
  return rows[0] ? connectorResultRow(rows[0]) : null;
}

export async function getConnectorResultByWorkOrder(
  workOrderCommitment: string,
): Promise<PrivateConnectorResultRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(connectorResults.values())
      .filter((record) => record.work_order_commitment === workOrderCommitment)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_connector_results
    WHERE work_order_commitment = ${workOrderCommitment}
    ORDER BY updated_at DESC
    LIMIT 1
  `) as ConnectorResultRow[];
  return rows[0] ? connectorResultRow(rows[0]) : null;
}

export async function listConnectorResults(
  ownerCommitment: string,
  limit = 50,
): Promise<PrivateConnectorResultRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(connectorResults.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_connector_results
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY updated_at DESC
    LIMIT ${safeLimit}
  `) as ConnectorResultRow[];
  return rows.map(connectorResultRow);
}

export async function putRuntimeEnvelope(
  record: PrivateRuntimeEnvelopeRecordV1,
): Promise<PrivateRuntimeEnvelopeRecordV1> {
  const sql = await getSql();
  if (!sql) {
    runtimeEnvelopes.set(record.runtime_envelope_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_runtime_envelopes (
      runtime_envelope_commitment,
      owner_commitment,
      intent_id,
      account_commitment,
      action_commitment,
      platform_class,
      envelope,
      created_at,
      expires_at
    ) VALUES (
      ${record.runtime_envelope_commitment},
      ${record.owner_commitment},
      ${record.intent_id},
      ${record.account_commitment},
      ${record.action_commitment},
      ${record.platform_class},
      ${JSON.stringify(record.envelope)}::jsonb,
      ${record.created_at},
      ${record.expires_at}
    )
    ON CONFLICT (runtime_envelope_commitment) DO NOTHING
  `;
  return record;
}

export async function getRuntimeEnvelope(
  runtimeEnvelopeCommitment: string,
): Promise<PrivateRuntimeEnvelopeRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return runtimeEnvelopes.get(runtimeEnvelopeCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_runtime_envelopes
    WHERE runtime_envelope_commitment = ${runtimeEnvelopeCommitment}
    LIMIT 1
  `) as RuntimeEnvelopeRow[];
  return rows[0] ? runtimeEnvelopeRow(rows[0]) : null;
}

export async function getRuntimeEnvelopeByIntent(
  intentId: string,
): Promise<PrivateRuntimeEnvelopeRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(runtimeEnvelopes.values())
      .filter((record) => record.intent_id === intentId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_runtime_envelopes
    WHERE intent_id = ${intentId}
    ORDER BY created_at DESC
    LIMIT 1
  `) as RuntimeEnvelopeRow[];
  return rows[0] ? runtimeEnvelopeRow(rows[0]) : null;
}

export async function putScheduleDecision(
  record: PrivateScheduleDecisionRecordV1,
): Promise<PrivateScheduleDecisionRecordV1> {
  const sql = await getSql();
  if (!sql) {
    scheduleDecisions.set(record.schedule_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_schedule_decisions (
      schedule_commitment,
      owner_commitment,
      intent_id,
      preview_commitment,
      decision,
      created_at
    ) VALUES (
      ${record.schedule_commitment},
      ${record.owner_commitment},
      ${record.intent_id},
      ${record.preview_commitment},
      ${JSON.stringify(record.decision)}::jsonb,
      ${record.created_at}
    )
    ON CONFLICT (schedule_commitment) DO NOTHING
  `;
  return record;
}

export async function getScheduleDecision(
  scheduleCommitment: string,
): Promise<PrivateScheduleDecisionRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return scheduleDecisions.get(scheduleCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_schedule_decisions
    WHERE schedule_commitment = ${scheduleCommitment}
    LIMIT 1
  `) as ScheduleDecisionRow[];
  return rows[0] ? scheduleDecisionRow(rows[0]) : null;
}

export async function putPlatformRotation(
  record: PrivatePlatformRotationRecordV1,
): Promise<PrivatePlatformRotationRecordV1> {
  const sql = await getSql();
  if (!sql) {
    platformRotations.set(record.rotation_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_platform_rotations (
      rotation_commitment,
      owner_commitment,
      account_commitment,
      platform_class,
      rotation,
      created_at
    ) VALUES (
      ${record.rotation_commitment},
      ${record.owner_commitment},
      ${record.account_commitment},
      ${record.platform_class},
      ${JSON.stringify(record.rotation)}::jsonb,
      ${record.created_at}
    )
    ON CONFLICT (rotation_commitment) DO NOTHING
  `;
  return record;
}

export async function getPlatformRotation(
  rotationCommitment: string,
): Promise<PrivatePlatformRotationRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return platformRotations.get(rotationCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_platform_rotations
    WHERE rotation_commitment = ${rotationCommitment}
    LIMIT 1
  `) as PlatformRotationRow[];
  return rows[0] ? platformRotationRow(rows[0]) : null;
}

export async function listPlatformRotations(
  ownerCommitment: string,
  limit = 100,
): Promise<PrivatePlatformRotationRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(platformRotations.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_platform_rotations
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `) as PlatformRotationRow[];
  return rows.map(platformRotationRow);
}

export async function putLinkabilitySimulation(
  record: PrivateLinkabilitySimulationRecordV1,
): Promise<PrivateLinkabilitySimulationRecordV1> {
  const sql = await getSql();
  if (!sql) {
    linkabilitySimulations.set(record.simulator_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_linkability_simulations (
      simulator_commitment,
      owner_commitment,
      intent_id,
      preview_commitment,
      simulation,
      created_at
    ) VALUES (
      ${record.simulator_commitment},
      ${record.owner_commitment},
      ${record.intent_id},
      ${record.preview_commitment},
      ${JSON.stringify(record.simulation)}::jsonb,
      ${record.created_at}
    )
    ON CONFLICT (simulator_commitment) DO NOTHING
  `;
  return record;
}

export async function getLinkabilitySimulation(
  simulatorCommitment: string,
): Promise<PrivateLinkabilitySimulationRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return linkabilitySimulations.get(simulatorCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_linkability_simulations
    WHERE simulator_commitment = ${simulatorCommitment}
    LIMIT 1
  `) as LinkabilitySimulationRow[];
  return rows[0] ? linkabilitySimulationRow(rows[0]) : null;
}

export async function listLinkabilitySimulations(
  ownerCommitment: string,
  limit = 100,
): Promise<PrivateLinkabilitySimulationRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(linkabilitySimulations.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_linkability_simulations
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `) as LinkabilitySimulationRow[];
  return rows.map(linkabilitySimulationRow);
}

export async function putRuntimeHealth(
  record: PrivateRuntimeHealthRecordV1,
): Promise<PrivateRuntimeHealthRecordV1> {
  const sql = await getSql();
  if (!sql) {
    runtimeHealthRecords.set(record.runtime_health_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_runtime_health (
      runtime_health_commitment,
      health,
      created_at
    ) VALUES (
      ${record.runtime_health_commitment},
      ${JSON.stringify(record.health)}::jsonb,
      ${record.created_at}
    )
    ON CONFLICT (runtime_health_commitment) DO NOTHING
  `;
  return record;
}

export async function putViewKey(
  record: PrivateViewKeyRecordV1,
): Promise<PrivateViewKeyRecordV1> {
  const sql = await getSql();
  if (!sql) {
    viewKeys.set(record.view_key_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_view_keys (
      view_key_commitment,
      owner_commitment,
      view_key,
      created_at,
      updated_at
    ) VALUES (
      ${record.view_key_commitment},
      ${record.owner_commitment},
      ${JSON.stringify(record.view_key)}::jsonb,
      ${record.created_at},
      ${record.updated_at}
    )
    ON CONFLICT (view_key_commitment) DO UPDATE SET
      view_key = EXCLUDED.view_key,
      updated_at = EXCLUDED.updated_at
  `;
  return record;
}

export async function getViewKey(
  viewKeyCommitment: string,
): Promise<PrivateViewKeyRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return viewKeys.get(viewKeyCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_view_keys
    WHERE view_key_commitment = ${viewKeyCommitment}
    LIMIT 1
  `) as ViewKeyRow[];
  return rows[0] ? viewKeyRow(rows[0]) : null;
}

export async function putPrivateReceiptExport(
  record: PrivateReceiptExportRecordV1,
): Promise<PrivateReceiptExportRecordV1> {
  const sql = await getSql();
  if (!sql) {
    receiptExports.set(record.private_export_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_receipt_exports (
      private_export_commitment,
      owner_commitment,
      receipt_commitment,
      view_key_commitment,
      private_export,
      created_at,
      revoked_at
    ) VALUES (
      ${record.private_export_commitment},
      ${record.owner_commitment},
      ${record.receipt_commitment},
      ${record.view_key_commitment},
      ${JSON.stringify(record.private_export)}::jsonb,
      ${record.created_at},
      ${record.revoked_at}
    )
    ON CONFLICT (private_export_commitment) DO UPDATE SET
      private_export = EXCLUDED.private_export,
      revoked_at = EXCLUDED.revoked_at
  `;
  return record;
}

export async function getPrivateReceiptExport(
  privateExportCommitment: string,
): Promise<PrivateReceiptExportRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return receiptExports.get(privateExportCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_receipt_exports
    WHERE private_export_commitment = ${privateExportCommitment}
    LIMIT 1
  `) as ReceiptExportRow[];
  return rows[0] ? receiptExportRow(rows[0]) : null;
}

export async function putPrivateReceiptExportRevocation(
  record: PrivateReceiptExportRevocationRecordV1,
): Promise<PrivateReceiptExportRevocationRecordV1> {
  const sql = await getSql();
  if (!sql) {
    receiptExportRevocations.set(record.revocation_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_receipt_export_revocations (
      revocation_commitment,
      owner_commitment,
      private_export_commitment,
      view_key_commitment,
      revocation,
      revoked_at
    ) VALUES (
      ${record.revocation_commitment},
      ${record.owner_commitment},
      ${record.private_export_commitment},
      ${record.view_key_commitment},
      ${JSON.stringify(record.revocation)}::jsonb,
      ${record.revoked_at}
    )
    ON CONFLICT (revocation_commitment) DO NOTHING
  `;
  return record;
}

export async function putPrivateAccountReceipt(
  record: PrivateAccountReceiptRecordV1,
): Promise<PrivateAccountReceiptRecordV1> {
  const sql = await getSql();
  if (!sql) {
    receipts.set(record.receipt_commitment, record);
    return record;
  }
  await ensureSchema(sql);
  await sql`
    INSERT INTO private_account_receipts (
      receipt_commitment,
      owner_commitment,
      intent_id,
      preview_commitment,
      approval_commitment,
      receipt,
      created_at
    ) VALUES (
      ${record.receipt_commitment},
      ${record.owner_commitment},
      ${record.intent_id},
      ${record.preview_commitment},
      ${record.approval_commitment},
      ${JSON.stringify(record.receipt)}::jsonb,
      ${record.created_at}
    )
    ON CONFLICT (receipt_commitment) DO UPDATE SET receipt = EXCLUDED.receipt
  `;
  return record;
}

export async function getPrivateAccountReceipt(
  receiptCommitment: string,
): Promise<PrivateAccountReceiptRecordV1 | null> {
  const sql = await getSql();
  if (!sql) return receipts.get(receiptCommitment) ?? null;
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_receipts
    WHERE receipt_commitment = ${receiptCommitment}
    LIMIT 1
  `) as ReceiptRow[];
  return rows[0] ? receiptRow(rows[0]) : null;
}

export async function getPrivateAccountReceiptByIntent(
  intentId: string,
): Promise<PrivateAccountReceiptRecordV1 | null> {
  const sql = await getSql();
  if (!sql) {
    return Array.from(receipts.values()).find((record) => record.intent_id === intentId) ?? null;
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_receipts
    WHERE intent_id = ${intentId}
    ORDER BY created_at DESC
    LIMIT 1
  `) as ReceiptRow[];
  return rows[0] ? receiptRow(rows[0]) : null;
}

export async function listPrivateAccountReceipts(
  ownerCommitment: string,
  limit = 10,
): Promise<PrivateAccountReceiptRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(receipts.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_receipts
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `) as ReceiptRow[];
  return rows.map(receiptRow);
}

export async function listPrivateAccountIntents(
  ownerCommitment: string,
  limit = 10,
): Promise<PrivateAccountIntentRecordV1[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sql = await getSql();
  if (!sql) {
    return Array.from(intents.values())
      .filter((record) => record.owner_commitment === ownerCommitment)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, safeLimit);
  }
  await ensureSchema(sql);
  const rows = (await sql`
    SELECT * FROM private_account_intents
    WHERE owner_commitment = ${ownerCommitment}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `) as IntentRow[];
  return rows.map(intentRow);
}

export async function resetPrivateAccountStoreForTests() {
  intents.clear();
  previews.clear();
  approvals.clear();
  executions.clear();
  executionPlans.clear();
  settlements.clear();
  receipts.clear();
  accounts.clear();
  vaults.clear();
  hyperliquidVaults.clear();
  hyperliquidManagedAllocations.clear();
  venueExecutionVaults.clear();
  venueSecretHandles.clear();
  stealthVenueAccounts.clear();
  pooledVenueAllocations.clear();
  omnibusAllocations.clear();
  budgets.clear();
  queuedActions.clear();
  anonymityEvidence.clear();
  fundingInstructions.clear();
  fundingImports.clear();
  fundingBatches.clear();
  fundingBatchRuns.clear();
  auctionEpochs.clear();
  auctionOrders.clear();
  auctionClearings.clear();
  auctionPreparedTransactions.clear();
  coordinatorLocks.clear();
  modeCanaries.clear();
  connectorManifests.clear();
  compiledIntents.clear();
  linkabilityScores.clear();
  connectorWorkOrders.clear();
  connectorResults.clear();
  runtimeEnvelopes.clear();
  scheduleDecisions.clear();
  platformRotations.clear();
  linkabilitySimulations.clear();
  runtimeHealthRecords.clear();
  viewKeys.clear();
  receiptExports.clear();
  receiptExportRevocations.clear();
  if (process.env.GHOLA_PRIVATE_ACCOUNT_STORE !== "postgres") {
    sqlClient = null;
    schemaReady = false;
  }
}

async function getSql(): Promise<NeonSql | null> {
  if (!shouldUsePostgresStore()) return null;
  if (sqlClient) return sqlClient;
  const databaseUrl =
    process.env.GHOLA_PRIVATE_ACCOUNT_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    null;
  if (!databaseUrl) return null;
  const { neon } = await import("@neondatabase/serverless");
  sqlClient = neon(databaseUrl);
  return sqlClient;
}

function shouldUsePostgresStore(): boolean {
  if (process.env.GHOLA_PRIVATE_ACCOUNT_STORE === "memory") return false;
  if (process.env.GHOLA_PRIVATE_ACCOUNT_STORE === "postgres") return true;
  if (process.env.NODE_ENV === "test") return false;
  return Boolean(
    process.env.GHOLA_PRIVATE_ACCOUNT_DATABASE_URL ||
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL,
  );
}

async function ensureSchema(sql: NeonSql): Promise<void> {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_intents (
      intent_id TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL DEFAULT 'owner_legacy',
      account_commitment TEXT NOT NULL,
      action_commitment TEXT NOT NULL,
      action_class TEXT NOT NULL,
      product_bucket TEXT NOT NULL,
      policy_commitment TEXT NOT NULL,
      intent_commitment TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_previews (
      preview_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL DEFAULT 'owner_legacy',
      intent_id TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      action_commitment TEXT NOT NULL,
      platform_class TEXT NOT NULL,
      selected_rail TEXT NOT NULL,
      claim_status TEXT NOT NULL,
      anonymity_level TEXT NOT NULL,
      preview JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_approvals (
      approval_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL DEFAULT 'owner_legacy',
      preview_commitment TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      execution_plan_commitment TEXT,
      degraded_accepted BOOLEAN NOT NULL,
      approved_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_executions (
      execution_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL DEFAULT 'owner_legacy',
      intent_id TEXT NOT NULL,
      preview_commitment TEXT NOT NULL,
      approval_commitment TEXT NOT NULL,
      execution_plan_commitment TEXT,
      settlement_commitment TEXT,
      claim_status TEXT NOT NULL,
      rail_used TEXT NOT NULL,
      receipt_commitment TEXT NOT NULL,
      evidence_chain JSONB,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_execution_plans (
      plan_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      preview_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      action_commitment TEXT NOT NULL,
      status TEXT NOT NULL,
      selected_rail TEXT NOT NULL,
      plan JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_settlements (
      settlement_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      execution_commitment TEXT NOT NULL,
      plan_commitment TEXT NOT NULL,
      preview_commitment TEXT NOT NULL,
      approval_commitment TEXT NOT NULL,
      rail_used TEXT NOT NULL,
      lifecycle_status TEXT NOT NULL DEFAULT 'finalized',
      root_commitment TEXT,
      witness_commitment TEXT,
      proof_commitment TEXT,
      relay_commitment TEXT,
      finality_commitment TEXT,
      attestation_commitment TEXT,
      failure_reason TEXT,
      evidence JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_mode_canaries (
      canary_id TEXT PRIMARY KEY,
      canary_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      evidence_commitment TEXT,
      observed_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_connector_manifests (
      manifest_commitment TEXT PRIMARY KEY,
      platform_class TEXT NOT NULL,
      manifest JSONB NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_compiled_intents (
      compiler_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      action_commitment TEXT NOT NULL,
      platform_class TEXT NOT NULL,
      manifest_commitment TEXT NOT NULL,
      compiled_intent JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_linkability_scores (
      score_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      platform_class TEXT NOT NULL,
      amount_bucket TEXT NOT NULL,
      asset_bucket TEXT NOT NULL,
      destination_class TEXT NOT NULL,
      score JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_connector_work_orders (
      work_order_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      action_commitment TEXT NOT NULL,
      preview_commitment TEXT NOT NULL,
      approval_commitment TEXT,
      execution_plan_commitment TEXT,
      platform_class TEXT NOT NULL,
      status TEXT NOT NULL,
      work_order JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_connector_results (
      connector_result_commitment TEXT PRIMARY KEY,
      work_order_commitment TEXT NOT NULL,
      owner_commitment TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      platform_class TEXT NOT NULL,
      status TEXT NOT NULL,
      result JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_runtime_envelopes (
      runtime_envelope_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      action_commitment TEXT NOT NULL,
      platform_class TEXT NOT NULL,
      envelope JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_schedule_decisions (
      schedule_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      preview_commitment TEXT,
      decision JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_platform_rotations (
      rotation_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      platform_class TEXT NOT NULL,
      rotation JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_linkability_simulations (
      simulator_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      preview_commitment TEXT,
      simulation JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_runtime_health (
      runtime_health_commitment TEXT PRIMARY KEY,
      health JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_view_keys (
      view_key_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      view_key JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_receipt_exports (
      private_export_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      receipt_commitment TEXT NOT NULL,
      view_key_commitment TEXT NOT NULL,
      private_export JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_receipt_export_revocations (
      revocation_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      private_export_commitment TEXT NOT NULL,
      view_key_commitment TEXT NOT NULL,
      revocation JSONB NOT NULL,
      revoked_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_receipts (
      receipt_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL DEFAULT 'owner_legacy',
      intent_id TEXT NOT NULL,
      preview_commitment TEXT NOT NULL,
      approval_commitment TEXT NOT NULL,
      receipt JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_coordinator_locks (
      lock_id TEXT PRIMARY KEY,
      run_window_commitment TEXT NOT NULL,
      acquired_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_accounts (
      account_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      session_commitment TEXT NOT NULL,
      turnkey_wallet_commitment TEXT NOT NULL,
      vault_root_commitment TEXT NOT NULL,
      note_root_commitment TEXT NOT NULL,
      nullifier_root_commitment TEXT NOT NULL,
      platform_link_root TEXT NOT NULL,
      policy_commitment TEXT NOT NULL,
      privacy_mode TEXT NOT NULL,
      claim_boundary TEXT NOT NULL,
      vault_ready BOOLEAN NOT NULL,
      account JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_vaults (
      account_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      vault_root_commitment TEXT NOT NULL,
      note_root_commitment TEXT NOT NULL,
      nullifier_root_commitment TEXT NOT NULL,
      balance_bucket_summary JSONB NOT NULL,
      ready_rails JSONB NOT NULL,
      last_import_commitment TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_hyperliquid_vaults (
      vault_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      encrypted_vault_commitment TEXT NOT NULL,
      recipient_commitment TEXT NOT NULL,
      policy_commitment TEXT NOT NULL,
      status TEXT NOT NULL,
      vault JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_hyperliquid_allocations (
      allocation_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      policy_commitment TEXT NOT NULL,
      pool_commitment TEXT NOT NULL,
      subledger_account_commitment TEXT NOT NULL,
      status TEXT NOT NULL,
      allocation JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_venue_vaults (
      vault_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      venue_id TEXT NOT NULL,
      platform_class TEXT NOT NULL,
      execution_mode TEXT NOT NULL,
      encrypted_vault_commitment TEXT NOT NULL,
      recipient_commitment TEXT NOT NULL,
      policy_commitment TEXT NOT NULL,
      allocation_commitment TEXT,
      status TEXT NOT NULL,
      vault JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_venue_secret_handles (
      secret_handle_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      venue_id TEXT NOT NULL,
      platform_class TEXT NOT NULL,
      account_mode TEXT NOT NULL,
      purpose TEXT NOT NULL,
      status TEXT NOT NULL,
      secret_handle JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_stealth_venue_accounts (
      venue_account_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      venue_id TEXT NOT NULL,
      platform_class TEXT NOT NULL,
      secret_handle_commitment TEXT NOT NULL,
      status TEXT NOT NULL,
      venue_account JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_pooled_venue_allocations (
      pooled_allocation_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      venue_id TEXT NOT NULL,
      platform_class TEXT NOT NULL,
      pool_commitment TEXT NOT NULL,
      subledger_account_commitment TEXT NOT NULL,
      status TEXT NOT NULL,
      allocation JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_omnibus_allocations (
      allocation_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      venue_id TEXT NOT NULL,
      platform_class TEXT NOT NULL,
      pool_commitment TEXT NOT NULL,
      partner_commitment TEXT NOT NULL,
      subledger_account_commitment TEXT NOT NULL,
      settlement_funding_commitment TEXT,
      utilization_bucket TEXT NOT NULL,
      status TEXT NOT NULL,
      allocation JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_privacy_budgets (
      account_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      budget JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_action_queue (
      queue_id TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      action_commitment TEXT NOT NULL,
      latest_preview_commitment TEXT NOT NULL,
      platform_class TEXT NOT NULL,
      requested_rail TEXT NOT NULL,
      wait_reasons JSONB NOT NULL,
      target_anonymity_set INTEGER NOT NULL,
      current_anonymity_set INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_anonymity_evidence (
      evidence_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      intent_id TEXT,
      action_commitment TEXT,
      queue_id TEXT,
      source TEXT NOT NULL,
      anonymity_set JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_funding_instructions (
      funding_intent_id TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      funding_intent_commitment TEXT NOT NULL,
      asset_bucket TEXT NOT NULL,
      amount_bucket TEXT NOT NULL,
      shielded_rail TEXT NOT NULL,
      destination_commitment TEXT NOT NULL,
      shielded_destination TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_funding_imports (
      import_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      funding_intent_id TEXT NOT NULL,
      funding_intent_commitment TEXT NOT NULL,
      receipt_commitment TEXT NOT NULL,
      nullifier_commitment TEXT NOT NULL,
      note_root_commitment TEXT NOT NULL,
      amount_bucket TEXT NOT NULL,
      asset_bucket TEXT NOT NULL,
      shielded_rail TEXT NOT NULL,
      verifier_status TEXT NOT NULL,
      verifier_commitment TEXT NOT NULL DEFAULT 'verifier_legacy',
      verifier_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verifier_head_commitment TEXT NOT NULL DEFAULT 'head_legacy',
      confirmation_depth INTEGER NOT NULL DEFAULT 0,
      network TEXT NOT NULL DEFAULT 'unknown',
      rejection_reason TEXT,
      imported_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_funding_batches (
      batch_id TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      queue_id TEXT,
      action_commitment TEXT,
      selected_import_commitment TEXT,
      amount_bucket TEXT NOT NULL,
      asset_bucket TEXT NOT NULL,
      network TEXT NOT NULL DEFAULT 'unknown',
      shielded_rail TEXT NOT NULL,
      import_commitments JSONB NOT NULL,
      effective_anonymity_set INTEGER NOT NULL,
      required_anonymity_set INTEGER NOT NULL,
      timing_window_met BOOLEAN NOT NULL,
      evidence_commitment TEXT,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_funding_batch_runs (
      run_id TEXT PRIMARY KEY,
      coordinator_commitment TEXT NOT NULL,
      status TEXT NOT NULL,
      accounts_scanned INTEGER NOT NULL,
      queues_scanned INTEGER NOT NULL,
      imports_scanned INTEGER NOT NULL,
      batches_written INTEGER NOT NULL,
      evidence_written INTEGER NOT NULL,
      stale_imports INTEGER NOT NULL,
      rejected_imports INTEGER NOT NULL,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_auction_epochs (
      auction_epoch_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      market_commitment TEXT NOT NULL,
      platform_class TEXT NOT NULL,
      asset_bucket TEXT NOT NULL,
      amount_bucket TEXT NOT NULL,
      status TEXT NOT NULL,
      order_count INTEGER NOT NULL,
      matched_count INTEGER NOT NULL,
      rolled_count INTEGER NOT NULL,
      opened_at TIMESTAMPTZ NOT NULL,
      closes_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_auction_orders (
      auction_order_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      auction_epoch_commitment TEXT NOT NULL,
      queue_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      action_commitment TEXT NOT NULL,
      action_class TEXT NOT NULL,
      platform_class TEXT NOT NULL,
      side TEXT NOT NULL,
      asset_bucket TEXT NOT NULL,
      amount_bucket TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_auction_clearings (
      clearing_commitment TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      auction_epoch_commitment TEXT NOT NULL,
      status TEXT NOT NULL,
      clearing_price_commitment TEXT NOT NULL,
      matched_order_commitments JSONB NOT NULL,
      rolled_order_commitments JSONB NOT NULL,
      proof_commitment TEXT NOT NULL,
      settlement_commitment TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS private_account_auction_prepared_transactions (
      client_reference TEXT PRIMARY KEY,
      owner_commitment TEXT NOT NULL,
      account_commitment TEXT NOT NULL,
      operation TEXT NOT NULL,
      transaction_base64 TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL,
      signature TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`ALTER TABLE private_account_intents ADD COLUMN IF NOT EXISTS owner_commitment TEXT NOT NULL DEFAULT 'owner_legacy'`;
  await sql`ALTER TABLE private_account_previews ADD COLUMN IF NOT EXISTS owner_commitment TEXT NOT NULL DEFAULT 'owner_legacy'`;
  await sql`ALTER TABLE private_account_approvals ADD COLUMN IF NOT EXISTS owner_commitment TEXT NOT NULL DEFAULT 'owner_legacy'`;
  await sql`ALTER TABLE private_account_approvals ADD COLUMN IF NOT EXISTS execution_plan_commitment TEXT`;
  await sql`ALTER TABLE private_account_executions ADD COLUMN IF NOT EXISTS owner_commitment TEXT NOT NULL DEFAULT 'owner_legacy'`;
  await sql`ALTER TABLE private_account_executions ADD COLUMN IF NOT EXISTS evidence_chain JSONB`;
  await sql`ALTER TABLE private_account_executions ADD COLUMN IF NOT EXISTS execution_plan_commitment TEXT`;
  await sql`ALTER TABLE private_account_executions ADD COLUMN IF NOT EXISTS settlement_commitment TEXT`;
  await sql`ALTER TABLE private_account_settlements ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'finalized'`;
  await sql`ALTER TABLE private_account_settlements ADD COLUMN IF NOT EXISTS root_commitment TEXT`;
  await sql`ALTER TABLE private_account_settlements ADD COLUMN IF NOT EXISTS witness_commitment TEXT`;
  await sql`ALTER TABLE private_account_settlements ADD COLUMN IF NOT EXISTS proof_commitment TEXT`;
  await sql`ALTER TABLE private_account_settlements ADD COLUMN IF NOT EXISTS relay_commitment TEXT`;
  await sql`ALTER TABLE private_account_settlements ADD COLUMN IF NOT EXISTS finality_commitment TEXT`;
  await sql`ALTER TABLE private_account_settlements ADD COLUMN IF NOT EXISTS attestation_commitment TEXT`;
  await sql`ALTER TABLE private_account_settlements ADD COLUMN IF NOT EXISTS failure_reason TEXT`;
  await sql`ALTER TABLE private_account_settlements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
  await sql`ALTER TABLE private_account_receipts ADD COLUMN IF NOT EXISTS owner_commitment TEXT NOT NULL DEFAULT 'owner_legacy'`;
  await sql`ALTER TABLE private_account_funding_imports ADD COLUMN IF NOT EXISTS verifier_commitment TEXT NOT NULL DEFAULT 'verifier_legacy'`;
  await sql`ALTER TABLE private_account_funding_imports ADD COLUMN IF NOT EXISTS verifier_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
  await sql`ALTER TABLE private_account_funding_imports ADD COLUMN IF NOT EXISTS verifier_head_commitment TEXT NOT NULL DEFAULT 'head_legacy'`;
  await sql`ALTER TABLE private_account_funding_imports ADD COLUMN IF NOT EXISTS confirmation_depth INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE private_account_funding_imports ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'unknown'`;
  await sql`ALTER TABLE private_account_funding_imports ADD COLUMN IF NOT EXISTS rejection_reason TEXT`;
  await sql`ALTER TABLE private_account_funding_batches ADD COLUMN IF NOT EXISTS selected_import_commitment TEXT`;
  await sql`ALTER TABLE private_account_funding_batches ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'unknown'`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_intents_account_created ON private_account_intents (account_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_intents_owner_created ON private_account_intents (owner_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_previews_intent ON private_account_previews (intent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_approvals_preview ON private_account_approvals (preview_commitment)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_executions_approval ON private_account_executions (approval_commitment)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_execution_plans_preview ON private_account_execution_plans (preview_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_execution_plans_owner_created ON private_account_execution_plans (owner_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_settlements_execution ON private_account_settlements (execution_commitment)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_settlements_owner_created ON private_account_settlements (owner_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_settlements_lifecycle ON private_account_settlements (lifecycle_status, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_mode_canaries_kind_observed ON private_account_mode_canaries (canary_kind, observed_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_connector_manifests_platform ON private_account_connector_manifests (platform_class, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_compiled_intents_intent ON private_account_compiled_intents (intent_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_linkability_owner ON private_account_linkability_scores (owner_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_linkability_platform ON private_account_linkability_scores (owner_commitment, platform_class, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_connector_work_orders_owner ON private_account_connector_work_orders (owner_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_connector_work_orders_preview ON private_account_connector_work_orders (preview_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_connector_results_owner ON private_account_connector_results (owner_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_connector_results_work_order ON private_account_connector_results (work_order_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_runtime_envelopes_intent ON private_account_runtime_envelopes (intent_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_runtime_envelopes_owner ON private_account_runtime_envelopes (owner_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_schedule_decisions_owner ON private_account_schedule_decisions (owner_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_platform_rotations_owner ON private_account_platform_rotations (owner_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_linkability_simulations_owner ON private_account_linkability_simulations (owner_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_view_keys_owner ON private_account_view_keys (owner_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_receipt_exports_owner ON private_account_receipt_exports (owner_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_receipt_exports_receipt ON private_account_receipt_exports (receipt_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_receipts_intent ON private_account_receipts (intent_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_receipts_owner_created ON private_account_receipts (owner_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_accounts_owner_created ON private_account_accounts (owner_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_hyperliquid_vaults_account ON private_account_hyperliquid_vaults (account_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_hyperliquid_vaults_owner ON private_account_hyperliquid_vaults (owner_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_hyperliquid_allocations_account ON private_account_hyperliquid_allocations (account_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_hyperliquid_allocations_owner ON private_account_hyperliquid_allocations (owner_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_venue_vaults_account ON private_account_venue_vaults (account_commitment, venue_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_venue_vaults_owner ON private_account_venue_vaults (owner_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_venue_secret_handles_account ON private_account_venue_secret_handles (account_commitment, venue_id, account_mode, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_venue_secret_handles_owner ON private_account_venue_secret_handles (owner_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_stealth_venue_accounts_account ON private_account_stealth_venue_accounts (account_commitment, venue_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_stealth_venue_accounts_owner ON private_account_stealth_venue_accounts (owner_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_pooled_venue_allocations_account ON private_account_pooled_venue_allocations (account_commitment, venue_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_pooled_venue_allocations_owner ON private_account_pooled_venue_allocations (owner_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_omnibus_allocations_account ON private_account_omnibus_allocations (account_commitment, venue_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_omnibus_allocations_owner ON private_account_omnibus_allocations (owner_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_queue_owner_created ON private_account_action_queue (owner_commitment, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_evidence_action_updated ON private_account_anonymity_evidence (account_commitment, action_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_evidence_queue_updated ON private_account_anonymity_evidence (account_commitment, queue_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_funding_instructions_owner_created ON private_account_funding_instructions (owner_commitment, created_at DESC)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_private_account_funding_imports_nullifier ON private_account_funding_imports (nullifier_commitment)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_funding_imports_owner_imported ON private_account_funding_imports (owner_commitment, imported_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_funding_imports_cohort ON private_account_funding_imports (asset_bucket, amount_bucket, shielded_rail, imported_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_funding_batches_owner_updated ON private_account_funding_batches (owner_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_funding_batches_evidence ON private_account_funding_batches (evidence_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_funding_batch_runs_updated ON private_account_funding_batch_runs (updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_auction_epochs_owner_updated ON private_account_auction_epochs (owner_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_auction_epochs_open ON private_account_auction_epochs (owner_commitment, platform_class, asset_bucket, amount_bucket, status, closes_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_auction_orders_owner_updated ON private_account_auction_orders (owner_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_auction_orders_epoch ON private_account_auction_orders (auction_epoch_commitment, created_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_auction_orders_queue ON private_account_auction_orders (queue_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_auction_clearings_owner_updated ON private_account_auction_clearings (owner_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_auction_clearings_epoch ON private_account_auction_clearings (auction_epoch_commitment, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_private_account_auction_prepared_owner_updated ON private_account_auction_prepared_transactions (owner_commitment, updated_at DESC)`;
  schemaReady = true;
}

function intentRow(row: IntentRow): PrivateAccountIntentRecordV1 {
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    intent_id: row.intent_id,
    account_commitment: row.account_commitment,
    action_commitment: row.action_commitment,
    action_class: row.action_class as GholaPrivateAccountActionClass,
    product_bucket: row.product_bucket,
    policy_commitment: row.policy_commitment,
    intent_commitment: row.intent_commitment,
    status: row.status as PrivateAccountIntentStatus,
    created_at: dateString(row.created_at),
    expires_at: dateString(row.expires_at),
  };
}

function previewRow(row: PreviewRow): PrivateAccountPreviewRecordV1 {
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    preview_commitment: row.preview_commitment,
    intent_id: row.intent_id,
    account_commitment: row.account_commitment,
    action_commitment: row.action_commitment,
    platform_class: row.platform_class as GholaPlatformClass,
    selected_rail: row.selected_rail as GholaRailKind,
    claim_status: row.claim_status as GholaClaimStatus,
    anonymity_level: row.anonymity_level as GholaAnonymityLevel,
    preview: row.preview as GholaPrivacyPreview,
    created_at: dateString(row.created_at),
    expires_at: dateString(row.expires_at),
    consumed_at: row.consumed_at ? dateString(row.consumed_at) : null,
  };
}

function approvalRow(row: ApprovalRow): PrivateAccountApprovalRecordV1 {
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    approval_commitment: row.approval_commitment,
    preview_commitment: row.preview_commitment,
    intent_id: row.intent_id,
    execution_plan_commitment: row.execution_plan_commitment ?? null,
    degraded_accepted: Boolean(row.degraded_accepted),
    approved_at: dateString(row.approved_at),
    expires_at: dateString(row.expires_at),
    consumed_at: row.consumed_at ? dateString(row.consumed_at) : null,
  };
}

function executionRow(row: ExecutionRow): PrivateAccountExecutionRecordV1 {
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    execution_commitment: row.execution_commitment,
    intent_id: row.intent_id,
    preview_commitment: row.preview_commitment,
    approval_commitment: row.approval_commitment,
    execution_plan_commitment: row.execution_plan_commitment ?? null,
    settlement_commitment: row.settlement_commitment ?? null,
    claim_status: row.claim_status as GholaClaimStatus,
    rail_used: row.rail_used as GholaRailKind,
    receipt_commitment: row.receipt_commitment,
    evidence_chain: (row.evidence_chain ?? null) as GholaPrivateModeEvidenceChain | null,
    status: row.status as "executed" | "blocked",
    created_at: dateString(row.created_at),
  };
}

function executionPlanRow(row: ExecutionPlanRow): PrivateExecutionPlanRecordV1 {
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    plan_commitment: row.plan_commitment,
    intent_id: row.intent_id,
    preview_commitment: row.preview_commitment,
    account_commitment: row.account_commitment,
    action_commitment: row.action_commitment,
    status: row.status as GholaPrivateExecutionPlan["status"],
    selected_rail: row.selected_rail as GholaRailKind,
    plan: row.plan as GholaPrivateExecutionPlan,
    created_at: dateString(row.created_at),
    expires_at: dateString(row.expires_at),
    consumed_at: row.consumed_at ? dateString(row.consumed_at) : null,
  };
}

function settlementRow(row: SettlementRow): PrivateSettlementRecordV1 {
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    settlement_commitment: row.settlement_commitment,
    execution_commitment: row.execution_commitment,
    plan_commitment: row.plan_commitment,
    preview_commitment: row.preview_commitment,
    approval_commitment: row.approval_commitment,
    rail_used: row.rail_used as GholaRailKind,
    lifecycle_status: (row.lifecycle_status ?? "finalized") as GholaPrivateSettlementLifecycleStatus,
    root_commitment: row.root_commitment ?? null,
    witness_commitment: row.witness_commitment ?? null,
    proof_commitment: row.proof_commitment ?? null,
    relay_commitment: row.relay_commitment ?? null,
    finality_commitment: row.finality_commitment ?? null,
    attestation_commitment: row.attestation_commitment ?? null,
    failure_reason: row.failure_reason ?? null,
    evidence: row.evidence as GholaShieldedSettlementEvidence,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at ?? row.created_at),
  };
}

function modeCanaryRow(row: ModeCanaryRow): PrivateModeCanaryRecordV1 {
  return {
    version: 1,
    canary_id: row.canary_id,
    canary_kind: row.canary_kind as GholaPrivateModeCanaryKind,
    status: row.status as "green" | "red",
    evidence_commitment: row.evidence_commitment ?? null,
    observed_at: dateString(row.observed_at),
    expires_at: dateString(row.expires_at),
    reason: row.reason ?? null,
    created_at: dateString(row.created_at),
  };
}

function connectorManifestRow(row: ConnectorManifestRow): PrivateConnectorManifestRecordV1 {
  return {
    version: 1,
    manifest_commitment: row.manifest_commitment,
    platform_class: row.platform_class as GholaPlatformClass,
    manifest: row.manifest as GholaConnectorManifest,
    status: row.status as PrivateConnectorManifestRecordV1["status"],
    created_at: dateString(row.created_at),
    expires_at: dateString(row.expires_at),
    updated_at: dateString(row.updated_at),
  };
}

function compiledIntentRow(row: CompiledIntentRow): PrivateCompiledIntentRecordV1 {
  return {
    version: 1,
    compiler_commitment: row.compiler_commitment,
    owner_commitment: row.owner_commitment,
    intent_id: row.intent_id,
    account_commitment: row.account_commitment,
    action_commitment: row.action_commitment,
    platform_class: row.platform_class as GholaPlatformClass,
    manifest_commitment: row.manifest_commitment,
    compiled_intent: row.compiled_intent as GholaCompiledPrivateIntent,
    created_at: dateString(row.created_at),
  };
}

function linkabilityScoreRow(row: LinkabilityScoreRow): PrivateLinkabilityScoreRecordV1 {
  return {
    version: 1,
    score_commitment: row.score_commitment,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    intent_id: row.intent_id,
    platform_class: row.platform_class as GholaPlatformClass,
    amount_bucket: row.amount_bucket,
    asset_bucket: row.asset_bucket,
    destination_class: row.destination_class,
    score: row.score as GholaLinkabilityScore,
    created_at: dateString(row.created_at),
  };
}

function connectorWorkOrderRow(row: ConnectorWorkOrderRow): PrivateConnectorWorkOrderRecordV1 {
  return {
    version: 1,
    work_order_commitment: row.work_order_commitment,
    owner_commitment: row.owner_commitment,
    intent_id: row.intent_id,
    account_commitment: row.account_commitment,
    action_commitment: row.action_commitment,
    preview_commitment: row.preview_commitment,
    approval_commitment: row.approval_commitment ?? null,
    execution_plan_commitment: row.execution_plan_commitment ?? null,
    platform_class: row.platform_class as GholaPlatformClass,
    status: row.status as GholaConnectorWorkOrder["status"],
    work_order: row.work_order as GholaConnectorWorkOrder,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function connectorResultRow(row: ConnectorResultRow): PrivateConnectorResultRecordV1 {
  return {
    version: 1,
    connector_result_commitment: row.connector_result_commitment,
    work_order_commitment: row.work_order_commitment,
    owner_commitment: row.owner_commitment,
    intent_id: row.intent_id,
    platform_class: row.platform_class as GholaPlatformClass,
    status: row.status as GholaConnectorResult["status"],
    result: row.result as GholaConnectorResult,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function runtimeEnvelopeRow(row: RuntimeEnvelopeRow): PrivateRuntimeEnvelopeRecordV1 {
  return {
    version: 1,
    runtime_envelope_commitment: row.runtime_envelope_commitment,
    owner_commitment: row.owner_commitment,
    intent_id: row.intent_id,
    account_commitment: row.account_commitment,
    action_commitment: row.action_commitment,
    platform_class: row.platform_class as GholaPlatformClass,
    envelope: row.envelope as GholaRuntimeEnvelope,
    created_at: dateString(row.created_at),
    expires_at: dateString(row.expires_at),
  };
}

function scheduleDecisionRow(row: ScheduleDecisionRow): PrivateScheduleDecisionRecordV1 {
  return {
    version: 1,
    schedule_commitment: row.schedule_commitment,
    owner_commitment: row.owner_commitment,
    intent_id: row.intent_id,
    preview_commitment: row.preview_commitment ?? null,
    decision: row.decision as GholaPrivacyScheduleDecision,
    created_at: dateString(row.created_at),
  };
}

function platformRotationRow(row: PlatformRotationRow): PrivatePlatformRotationRecordV1 {
  return {
    version: 1,
    rotation_commitment: row.rotation_commitment,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    platform_class: row.platform_class as GholaPlatformClass,
    rotation: row.rotation as GholaPlatformFundingRotation,
    created_at: dateString(row.created_at),
  };
}

function linkabilitySimulationRow(row: LinkabilitySimulationRow): PrivateLinkabilitySimulationRecordV1 {
  return {
    version: 1,
    simulator_commitment: row.simulator_commitment,
    owner_commitment: row.owner_commitment,
    intent_id: row.intent_id,
    preview_commitment: row.preview_commitment ?? null,
    simulation: row.simulation as GholaAdversarialLinkabilitySimulation,
    created_at: dateString(row.created_at),
  };
}

function viewKeyRow(row: ViewKeyRow): PrivateViewKeyRecordV1 {
  return {
    version: 1,
    view_key_commitment: row.view_key_commitment,
    owner_commitment: row.owner_commitment,
    view_key: row.view_key as GholaViewKey,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function receiptExportRow(row: ReceiptExportRow): PrivateReceiptExportRecordV1 {
  return {
    version: 1,
    private_export_commitment: row.private_export_commitment,
    owner_commitment: row.owner_commitment,
    receipt_commitment: row.receipt_commitment,
    view_key_commitment: row.view_key_commitment,
    private_export: row.private_export as GholaPrivateReceiptExport,
    created_at: dateString(row.created_at),
    revoked_at: row.revoked_at ? dateString(row.revoked_at) : null,
  };
}

function coordinatorLockRow(row: CoordinatorLockRow): PrivateCoordinatorLockRecordV1 {
  return {
    version: 1,
    lock_id: row.lock_id,
    run_window_commitment: row.run_window_commitment,
    acquired_at: dateString(row.acquired_at),
    expires_at: dateString(row.expires_at),
  };
}

function receiptRow(row: ReceiptRow): PrivateAccountReceiptRecordV1 {
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    receipt_commitment: row.receipt_commitment,
    intent_id: row.intent_id,
    preview_commitment: row.preview_commitment,
    approval_commitment: row.approval_commitment,
    receipt: row.receipt as GholaPrivateAccountReceipt,
    created_at: dateString(row.created_at),
  };
}

function accountRow(row: AccountRow): PrivateAccountRecordV1 {
  const account = row.account as GholaPrivateExecutionAccount;
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    session_commitment: row.session_commitment,
    turnkey_wallet_commitment: row.turnkey_wallet_commitment,
    vault_root_commitment: row.vault_root_commitment,
    note_root_commitment: row.note_root_commitment,
    nullifier_root_commitment: row.nullifier_root_commitment,
    platform_link_root: row.platform_link_root,
    policy_commitment: row.policy_commitment,
    privacy_mode: "private_mode",
    claim_boundary: "engine_gated_full_anonymity",
    vault_ready: Boolean(row.vault_ready),
    account,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function vaultRow(row: VaultRow): PrivateVaultStateRecordV1 {
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    vault_root_commitment: row.vault_root_commitment,
    note_root_commitment: row.note_root_commitment,
    nullifier_root_commitment: row.nullifier_root_commitment,
    balance_bucket_summary: Array.isArray(row.balance_bucket_summary)
      ? row.balance_bucket_summary.filter((item): item is string => typeof item === "string")
      : [],
    ready_rails: Array.isArray(row.ready_rails)
      ? row.ready_rails.filter((item): item is GholaRailKind => typeof item === "string")
      : [],
    last_import_commitment: row.last_import_commitment,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function hyperliquidVaultRow(row: HyperliquidVaultRow): PrivateHyperliquidVaultRecordV1 {
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    vault_commitment: row.vault_commitment,
    encrypted_vault_commitment: row.encrypted_vault_commitment,
    recipient_commitment: row.recipient_commitment,
    policy_commitment: row.policy_commitment,
    status: row.status as GholaHyperliquidExecutionVault["status"],
    vault: row.vault as GholaHyperliquidExecutionVault,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function hyperliquidManagedAllocationRow(
  row: HyperliquidManagedAllocationRow,
): PrivateHyperliquidManagedAllocationRecordV1 {
  const allocation = row.allocation as GholaHyperliquidManagedAllocation;
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    allocation_commitment: row.allocation_commitment,
    policy_commitment: row.policy_commitment,
    pool_commitment: row.pool_commitment,
    subledger_account_commitment: row.subledger_account_commitment,
    status: row.status as GholaHyperliquidManagedAllocation["status"],
    allocation,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function venueExecutionVaultRow(row: VenueExecutionVaultRow): PrivateVenueExecutionVaultRecordV1 {
  const vault = row.vault as GholaVenueExecutionVault;
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    venue_id: vault.venue_id,
    platform_class: vault.platform_class,
    execution_mode: vault.execution_mode,
    vault_commitment: row.vault_commitment,
    encrypted_vault_commitment: row.encrypted_vault_commitment,
    recipient_commitment: row.recipient_commitment,
    policy_commitment: row.policy_commitment,
    allocation_commitment: row.allocation_commitment,
    status: row.status as GholaVenueExecutionVault["status"],
    vault,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function venueSecretHandleRow(row: VenueSecretHandleRow): PrivateVenueSecretHandleRecordV1 {
  const secretHandle = row.secret_handle as GholaSecretHandle;
  return {
    version: 1,
    secret_handle_commitment: row.secret_handle_commitment,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    venue_id: secretHandle.venue_id,
    platform_class: secretHandle.platform_class,
    account_mode: secretHandle.account_mode,
    purpose: secretHandle.purpose,
    status: row.status as GholaSecretHandle["status"],
    secret_handle: secretHandle,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function stealthVenueAccountRow(row: StealthVenueAccountRow): PrivateStealthVenueAccountRecordV1 {
  const venueAccount = row.venue_account as GholaStealthVenueAccount;
  return {
    version: 1,
    venue_account_commitment: row.venue_account_commitment,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    venue_id: venueAccount.venue_id,
    platform_class: venueAccount.platform_class,
    secret_handle_commitment: row.secret_handle_commitment,
    status: row.status as GholaStealthVenueAccount["status"],
    venue_account: venueAccount,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function pooledVenueAllocationRow(row: PooledVenueAllocationRow): PrivatePooledVenueAllocationRecordV1 {
  const allocation = row.allocation as GholaPooledVenueAllocation;
  return {
    version: 1,
    pooled_allocation_commitment: row.pooled_allocation_commitment,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    venue_id: allocation.venue_id,
    platform_class: allocation.platform_class,
    pool_commitment: row.pool_commitment,
    subledger_account_commitment: row.subledger_account_commitment,
    status: row.status as GholaPooledVenueAllocation["status"],
    allocation,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function omnibusAllocationRow(row: OmnibusAllocationRow): PrivateOmnibusAllocationRecordV1 {
  const allocation = row.allocation as GholaOmnibusAllocation;
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    venue_id: allocation.venue_id,
    platform_class: allocation.platform_class,
    pool_commitment: row.pool_commitment,
    partner_commitment: row.partner_commitment,
    subledger_account_commitment: row.subledger_account_commitment,
    allocation_commitment: row.allocation_commitment,
    settlement_funding_commitment: row.settlement_funding_commitment,
    utilization_bucket: allocation.utilization_bucket,
    status: row.status as GholaOmnibusAllocation["status"],
    allocation,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function budgetRow(row: BudgetRow): PrivatePrivacyBudgetRecordV1 {
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    budget: { ...defaultBudget(), ...(row.budget as Partial<GholaPrivacyBudget>) },
    updated_at: dateString(row.updated_at),
  };
}

function queueRow(row: QueueRow): PrivateQueuedActionRecordV1 {
  return {
    version: 1,
    queue_id: row.queue_id,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    intent_id: row.intent_id,
    action_commitment: row.action_commitment,
    latest_preview_commitment: row.latest_preview_commitment,
    platform_class: row.platform_class as GholaPlatformClass,
    requested_rail: row.requested_rail as GholaRailKind,
    wait_reasons: Array.isArray(row.wait_reasons)
      ? row.wait_reasons.filter((item): item is string => typeof item === "string")
      : [],
    target_anonymity_set: Number(row.target_anonymity_set),
    current_anonymity_set: Number(row.current_anonymity_set),
    status: row.status as PrivateQueuedActionRecordV1["status"],
    created_at: dateString(row.created_at),
    expires_at: dateString(row.expires_at),
    updated_at: dateString(row.updated_at),
  };
}

function anonymityEvidenceRow(row: AnonymityEvidenceRow): PrivateAnonymityEvidenceRecordV1 {
  return {
    version: 1,
    evidence_commitment: row.evidence_commitment,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    intent_id: row.intent_id,
    action_commitment: row.action_commitment,
    queue_id: row.queue_id,
    source: row.source as PrivateAnonymityEvidenceRecordV1["source"],
    anonymity_set: {
      required: Number((row.anonymity_set as Partial<GholaAnonymitySetSummary>)?.required ?? 0),
      effective: Number((row.anonymity_set as Partial<GholaAnonymitySetSummary>)?.effective ?? 0),
      solver_count: (row.anonymity_set as Partial<GholaAnonymitySetSummary>)?.solver_count,
      amount_bucketed: Boolean((row.anonymity_set as Partial<GholaAnonymitySetSummary>)?.amount_bucketed),
      timing_window_met: Boolean((row.anonymity_set as Partial<GholaAnonymitySetSummary>)?.timing_window_met),
      uniqueness_score_bps: Number((row.anonymity_set as Partial<GholaAnonymitySetSummary>)?.uniqueness_score_bps ?? 10_000),
      repeated_pattern_score_bps: Number((row.anonymity_set as Partial<GholaAnonymitySetSummary>)?.repeated_pattern_score_bps ?? 0),
    },
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function fundingInstructionRow(row: FundingInstructionRow): PrivateFundingInstructionRecordV1 {
  return {
    version: 1,
    funding_intent_id: row.funding_intent_id,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    funding_intent_commitment: row.funding_intent_commitment,
    asset_bucket: row.asset_bucket,
    amount_bucket: row.amount_bucket,
    shielded_rail: row.shielded_rail as PrivateFundingRail,
    destination_commitment: row.destination_commitment,
    shielded_destination: row.shielded_destination,
    status: row.status as PrivateFundingStatus,
    created_at: dateString(row.created_at),
    expires_at: dateString(row.expires_at),
    updated_at: dateString(row.updated_at),
  };
}

function fundingImportRow(row: FundingImportRow): PrivateFundingImportRecordV1 {
  return {
    version: 1,
    import_commitment: row.import_commitment,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    funding_intent_id: row.funding_intent_id,
    funding_intent_commitment: row.funding_intent_commitment,
    receipt_commitment: row.receipt_commitment,
    nullifier_commitment: row.nullifier_commitment,
    note_root_commitment: row.note_root_commitment,
    amount_bucket: row.amount_bucket,
    asset_bucket: row.asset_bucket,
    shielded_rail: row.shielded_rail as PrivateFundingRail,
    verifier_status: row.verifier_status as PrivateFundingImportRecordV1["verifier_status"],
    verifier_commitment: row.verifier_commitment ?? "verifier_legacy",
    verifier_observed_at: dateString(row.verifier_observed_at ?? row.imported_at),
    verifier_head_commitment: row.verifier_head_commitment ?? "head_legacy",
    confirmation_depth: Number(row.confirmation_depth ?? 0),
    network: row.network ?? "unknown",
    rejection_reason: row.rejection_reason ?? null,
    imported_at: dateString(row.imported_at),
  };
}

function fundingBatchRow(row: FundingBatchRow): PrivateFundingBatchRecordV1 {
  return {
    version: 1,
    batch_id: row.batch_id,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    queue_id: row.queue_id,
    action_commitment: row.action_commitment,
    selected_import_commitment: row.selected_import_commitment,
    amount_bucket: row.amount_bucket,
    asset_bucket: row.asset_bucket,
    network: row.network ?? "unknown",
    shielded_rail: row.shielded_rail as PrivateFundingRail,
    import_commitments: Array.isArray(row.import_commitments)
      ? row.import_commitments.filter((item): item is string => typeof item === "string")
      : [],
    effective_anonymity_set: Number(row.effective_anonymity_set),
    required_anonymity_set: Number(row.required_anonymity_set),
    timing_window_met: Boolean(row.timing_window_met),
    evidence_commitment: row.evidence_commitment,
    status: row.status as PrivateFundingBatchStatus,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function fundingBatchRunRow(row: FundingBatchRunRow): PrivateFundingBatchRunRecordV1 {
  return {
    version: 1,
    run_id: row.run_id,
    coordinator_commitment: row.coordinator_commitment,
    status: row.status as PrivateFundingBatchRunRecordV1["status"],
    accounts_scanned: Number(row.accounts_scanned),
    queues_scanned: Number(row.queues_scanned),
    imports_scanned: Number(row.imports_scanned),
    batches_written: Number(row.batches_written),
    evidence_written: Number(row.evidence_written),
    stale_imports: Number(row.stale_imports),
    rejected_imports: Number(row.rejected_imports),
    error: row.error ?? null,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function auctionEpochRow(row: AuctionEpochRow): PrivateAuctionEpochRecordV1 {
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    auction_epoch_commitment: row.auction_epoch_commitment,
    market_commitment: row.market_commitment,
    platform_class: row.platform_class as GholaPlatformClass,
    asset_bucket: row.asset_bucket,
    amount_bucket: row.amount_bucket,
    status: row.status as GholaAuctionLifecycleStatus,
    order_count: Number(row.order_count),
    matched_count: Number(row.matched_count),
    rolled_count: Number(row.rolled_count),
    opened_at: dateString(row.opened_at),
    closes_at: dateString(row.closes_at),
    updated_at: dateString(row.updated_at),
  };
}

function auctionOrderRow(row: AuctionOrderRow): PrivateAuctionOrderRecordV1 {
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    auction_order_commitment: row.auction_order_commitment,
    auction_epoch_commitment: row.auction_epoch_commitment,
    queue_id: row.queue_id,
    intent_id: row.intent_id,
    action_commitment: row.action_commitment,
    action_class: row.action_class as GholaPrivateAccountActionClass,
    platform_class: row.platform_class as GholaPlatformClass,
    side: row.side as GholaAuctionOrderSide,
    asset_bucket: row.asset_bucket,
    amount_bucket: row.amount_bucket,
    status: row.status as PrivateAuctionOrderRecordV1["status"],
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function auctionClearingRow(row: AuctionClearingRow): PrivateAuctionClearingRecordV1 {
  return {
    version: 1,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    clearing_commitment: row.clearing_commitment,
    auction_epoch_commitment: row.auction_epoch_commitment,
    status: row.status as PrivateAuctionClearingRecordV1["status"],
    clearing_price_commitment: row.clearing_price_commitment,
    matched_order_commitments: Array.isArray(row.matched_order_commitments)
      ? row.matched_order_commitments.filter((item): item is string => typeof item === "string")
      : [],
    rolled_order_commitments: Array.isArray(row.rolled_order_commitments)
      ? row.rolled_order_commitments.filter((item): item is string => typeof item === "string")
      : [],
    proof_commitment: row.proof_commitment,
    settlement_commitment: row.settlement_commitment ?? null,
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function auctionPreparedTransactionRow(
  row: AuctionPreparedTransactionRow,
): PrivateAuctionPreparedTransactionRecordV1 {
  return {
    version: 1,
    client_reference: row.client_reference,
    owner_commitment: row.owner_commitment,
    account_commitment: row.account_commitment,
    operation: row.operation as PrivateAuctionPreparedOperation,
    transaction_base64: row.transaction_base64,
    payload: recordValue(row.payload),
    status: row.status as PrivateAuctionPreparedTransactionRecordV1["status"],
    signature: row.signature ?? null,
    created_at: dateString(row.created_at),
    expires_at: dateString(row.expires_at),
    updated_at: dateString(row.updated_at),
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function defaultBudget(): GholaPrivacyBudget {
  return {
    version: 1,
    degraded_action_count: 0,
    repeated_withdrawal_count: 0,
    repeated_cadence_count: 0,
    platform_concentration_bps: 0,
    solver_concentration_bps: 0,
  };
}

function dateString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
