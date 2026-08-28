import {
  carryRiskMandateMessage,
  createCarryPosition,
  normalizeCarryRiskMandateAuthorization,
  normalizeCarryRiskMandatePayload,
} from "@ghola/execution-core";
import { hashMessage, recoverMessageAddress, type Hex } from "viem";
import { CARRY_EXECUTION_VENUES } from "@/lib/carry-venues";

export interface CarryRiskMandatePayload {
  version: 1;
  kind: "ghola_carry_risk_mandate";
  strategy_id: "delta_neutral_carry_v1";
  network: "paper" | "testnet" | "mainnet";
  owner_commitment: string;
  owner_wallet_address: `0x${string}`;
  position_id: string;
  mandate_id: string;
  asset: string;
  long_venue_id: string;
  short_venue_id: string;
  target_notional_micro_usdc: number;
  opportunity_evidence_commitment?: string;
  risk_mandate: Record<string, unknown>;
  migration_parent_position_id?: string;
  migration_candidate_id?: string;
  issued_at_ms: number;
  expires_at_ms: number;
}

export function defaultCarryRiskMandate() {
  return {
    min_expected_net_benefit_bps: 5,
    exit_net_value_bps: 0,
    exit_after_consecutive_observations: 2,
    min_margin_runway_ms: 6 * 3_600_000,
    max_hedge_error_micro_usdc: 10_000,
    max_data_age_ms: 60_000,
    max_contract_data_skew_ms: 2_000,
    max_index_price_divergence_bps: 25,
    max_mark_price_divergence_bps: 50,
    min_migration_improvement_bps: 5,
    migration_venue_allowlist: [...CARRY_EXECUTION_VENUES],
    allow_migration: true,
  };
}

export interface CarryRiskMandateAuthorization {
  version: 1;
  signed_mandate: CarryRiskMandatePayload;
  signature: `0x${string}`;
  mandate_commitment: `0x${string}`;
}

export function buildCarryRiskMandatePayload(input: Omit<CarryRiskMandatePayload,
  "version" | "kind" | "strategy_id">): CarryRiskMandatePayload {
  return normalizeCarryRiskMandatePayload({
    version: 1,
    kind: "ghola_carry_risk_mandate",
    strategy_id: "delta_neutral_carry_v1",
    ...input,
  }) as unknown as CarryRiskMandatePayload;
}

export function carryRiskMandateCommitment(payload: CarryRiskMandatePayload): `0x${string}` {
  return hashMessage(carryRiskMandateMessage(payload));
}

export function carryRiskMandateAuthorization(input: {
  signed_mandate: CarryRiskMandatePayload;
  signature: `0x${string}`;
}): CarryRiskMandateAuthorization {
  return normalizeCarryRiskMandateAuthorization({
    version: 1,
    signed_mandate: input.signed_mandate,
    signature: input.signature,
    mandate_commitment: carryRiskMandateCommitment(input.signed_mandate),
  }) as unknown as CarryRiskMandateAuthorization;
}

export async function verifyCarryRiskMandateAuthorization(input: {
  owner_commitment: string;
  position_input: Record<string, unknown>;
  mandate_authorization: unknown;
  now_ms?: number;
}): Promise<
  | { ok: true; authorization: CarryRiskMandateAuthorization }
  | { ok: false; error: string }
> {
  try {
    const nowMs = input.now_ms ?? Date.now();
    const position = createCarryPosition({
      ...input.position_input,
      version: 1,
      mandate_authorization: input.mandate_authorization,
      now_ms: nowMs,
    }) as Record<string, unknown>;
    const authorization = position.mandate_authorization as unknown as CarryRiskMandateAuthorization;
    const signed = authorization.signed_mandate;
    if (signed.owner_commitment !== input.owner_commitment) {
      return { ok: false, error: "carry_mandate_owner_mismatch" };
    }
    if (authorization.mandate_commitment !== carryRiskMandateCommitment(signed)) {
      return { ok: false, error: "carry_mandate_commitment_mismatch" };
    }
    const recovered = await recoverMessageAddress({
      message: carryRiskMandateMessage(signed),
      signature: authorization.signature as Hex,
    });
    if (recovered.toLowerCase() !== signed.owner_wallet_address) {
      return { ok: false, error: "carry_mandate_signature_mismatch" };
    }
    return { ok: true, authorization };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "carry_mandate_authorization_invalid";
    return { ok: false, error: /^[a-z0-9_:-]{3,120}$/.test(code) ? code : "carry_mandate_authorization_invalid" };
  }
}
