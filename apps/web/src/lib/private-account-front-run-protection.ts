import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export type FrontRunProtectionKind =
  | "zero_certified"
  | "pre_submit_private"
  | "venue_visible"
  | "blocked";

export type FrontRunMode = "pre_submit_private" | "zero_front_run";

export type FrontRunAccessMode =
  | "byo_api_key"
  | "user_stealth"
  | "ghola_pooled"
  | "partner_omnibus"
  | "private_rfq"
  | "sealed_batch_auction"
  | "unknown";

export interface FrontRunProtection {
  kind: FrontRunProtectionKind;
  label: string;
  detail: string;
  zeroFrontRun: boolean;
  canLiveSubmitInZeroMode: boolean;
  reasonCodes: string[];
  certificateCommitment: string | null;
}

export interface FrontRunCertificate {
  version: 1;
  certificate_commitment: string;
  access_mode: "sealed_batch_auction";
  encrypted_until_match: true;
  no_public_mempool: true;
  fair_ordering: "uniform_batch_auction";
  auction_epoch_commitment: string;
  auction_order_commitment: string;
  clearing_commitment: string;
  proof_commitment: string;
  finality_commitment: string;
  runtime_attestation_commitment: string;
  reason_codes: [];
}

export function deriveFrontRunProtection(input: {
  accessMode?: FrontRunAccessMode | string | null;
  frontRunCertificateCommitment?: string | null;
  encryptedUntilMatch?: boolean | null;
  fairOrderingCertificate?: boolean | null;
  noPublicMempool?: boolean | null;
  uniformBatchAuction?: boolean | null;
  privateFirmQuote?: boolean | null;
  venueOrderVisible?: boolean | null;
  publicMempool?: boolean | null;
}): FrontRunProtection {
  const accessMode = normalizeAccessMode(input.accessMode);
  if (input.publicMempool === true) {
    return {
      kind: "blocked",
      label: "Public route blocked",
      detail: "Zero-front-run mode cannot use a public mempool or public pending-order route.",
      zeroFrontRun: false,
      canLiveSubmitInZeroMode: false,
      reasonCodes: ["public_mempool_visible"],
      certificateCommitment: null,
    };
  }

  const zeroCertified = Boolean(input.frontRunCertificateCommitment) ||
    (
      input.encryptedUntilMatch === true &&
      input.fairOrderingCertificate === true &&
      input.noPublicMempool === true &&
      (input.uniformBatchAuction === true || input.privateFirmQuote === true || accessMode === "sealed_batch_auction")
    );
  if (zeroCertified) {
    return {
      kind: "zero_certified",
      label: "Zero-front-run certified",
      detail: "Intent stays encrypted until fair matching or a firm private fill.",
      zeroFrontRun: true,
      canLiveSubmitInZeroMode: true,
      reasonCodes: [],
      certificateCommitment: input.frontRunCertificateCommitment ?? null,
    };
  }

  if (accessMode === "sealed_batch_auction") {
    return {
      kind: "blocked",
      label: "Zero-front-run pending",
      detail: "Waiting for sealed batch clearing and fair-ordering proof before this can be certified.",
      zeroFrontRun: false,
      canLiveSubmitInZeroMode: false,
      reasonCodes: ["front_run_certificate_missing"],
      certificateCommitment: null,
    };
  }

  const sealedAccess = accessMode === "byo_api_key" ||
    accessMode === "user_stealth" ||
    accessMode === "ghola_pooled" ||
    accessMode === "partner_omnibus" ||
    accessMode === "private_rfq";
  if (sealedAccess && input.venueOrderVisible !== false) {
    return {
      kind: "pre_submit_private",
      label: "Pre-submit private",
      detail: "Ghola hides the intent before submit; the venue can still see the submitted order.",
      zeroFrontRun: false,
      canLiveSubmitInZeroMode: false,
      reasonCodes: ["venue_can_observe_submitted_order", "fair_ordering_not_certified"],
      certificateCommitment: null,
    };
  }

  return {
    kind: "venue_visible",
    label: "Venue-visible order",
    detail: "This route does not prove encrypted fair ordering before live submit.",
    zeroFrontRun: false,
    canLiveSubmitInZeroMode: false,
    reasonCodes: ["fair_ordering_not_certified"],
    certificateCommitment: null,
  };
}

export function buildFrontRunCertificate(input: {
  accessMode?: FrontRunAccessMode | string | null;
  auctionEpochCommitment?: string | null;
  auctionOrderCommitment?: string | null;
  clearingCommitment?: string | null;
  proofCommitment?: string | null;
  finalityCommitment?: string | null;
  runtimeAttestationCommitment?: string | null;
}): FrontRunCertificate | null {
  if (normalizeAccessMode(input.accessMode) !== "sealed_batch_auction") return null;
  const auctionEpochCommitment = clean(input.auctionEpochCommitment);
  const auctionOrderCommitment = clean(input.auctionOrderCommitment);
  const clearingCommitment = clean(input.clearingCommitment);
  const proofCommitment = clean(input.proofCommitment);
  const finalityCommitment = clean(input.finalityCommitment);
  const runtimeAttestationCommitment = clean(input.runtimeAttestationCommitment);
  if (
    !auctionEpochCommitment ||
    !auctionOrderCommitment ||
    !clearingCommitment ||
    !proofCommitment ||
    !finalityCommitment ||
    !runtimeAttestationCommitment
  ) {
    return null;
  }
  const seed = {
    access_mode: "sealed_batch_auction",
    encrypted_until_match: true,
    no_public_mempool: true,
    fair_ordering: "uniform_batch_auction",
    auction_epoch_commitment: auctionEpochCommitment,
    auction_order_commitment: auctionOrderCommitment,
    clearing_commitment: clearingCommitment,
    proof_commitment: proofCommitment,
    finality_commitment: finalityCommitment,
    runtime_attestation_commitment: runtimeAttestationCommitment,
  };
  return {
    version: 1,
    certificate_commitment: commitment("front_run_certificate", seed),
    access_mode: "sealed_batch_auction",
    encrypted_until_match: true,
    no_public_mempool: true,
    fair_ordering: "uniform_batch_auction",
    auction_epoch_commitment: auctionEpochCommitment,
    auction_order_commitment: auctionOrderCommitment,
    clearing_commitment: clearingCommitment,
    proof_commitment: proofCommitment,
    finality_commitment: finalityCommitment,
    runtime_attestation_commitment: runtimeAttestationCommitment,
    reason_codes: [],
  };
}

export function zeroFrontRunBlocker(protection: FrontRunProtection): string | null {
  if (protection.canLiveSubmitInZeroMode) return null;
  if (protection.kind === "blocked") return protection.detail;
  return "Zero-front-run mode requires encrypted fair ordering, a sealed batch auction, or a firm private fill.";
}

function normalizeAccessMode(value: FrontRunAccessMode | string | null | undefined): FrontRunAccessMode {
  if (value === "byo_api_key" ||
    value === "user_stealth" ||
    value === "ghola_pooled" ||
    value === "partner_omnibus" ||
    value === "private_rfq" ||
    value === "sealed_batch_auction") {
    return value;
  }
  return "unknown";
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function commitment(prefix: string, value: unknown): string {
  return `${prefix}_${bytesToHex(sha256(new TextEncoder().encode(stableJson(value)))).slice(0, 48)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
