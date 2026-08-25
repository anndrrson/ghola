import {
  carryRiskMandateMessage,
  createCarryPosition,
  normalizeCarryRiskMandateAuthorization,
  normalizeCarryRiskMandatePayload,
} from "@ghola/execution-core";
import { hashMessage, recoverMessageAddress, type Hex } from "viem";

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
  risk_mandate: Record<string, unknown>;
  issued_at_ms: number;
  expires_at_ms: number;
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
