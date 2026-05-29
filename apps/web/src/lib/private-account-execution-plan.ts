import {
  gholaCommitment,
  isPrivateModeAvailableStatus,
  type GholaPrivateExecutionPlan,
  type GholaPrivateModeEvidenceChain,
  type GholaPrivateRailStep,
  type GholaPrivateSettlementLifecycleStatus,
  type GholaPrivacyPreview,
  type GholaRailKind,
  type GholaRelayStatusEvidence,
  type GholaRuntimeAttestationEvidence,
  type GholaShieldedPoolHealth,
  type GholaShieldedSettlementEvidence,
} from "./private-account";
import {
  shieldedPoolConfig,
  shieldedPoolHealth,
} from "./private-account-shielded-pool";

export type GholaPrivateSettlementError =
  | "private_execution_plan_not_ready"
  | "shielded_pool_unhealthy"
  | "sealed_runtime_unavailable"
  | "sealed_runtime_settlement_unavailable"
  | "settlement_evidence_malformed";

export function buildPrivateExecutionPlan(input: {
  preview: GholaPrivacyPreview;
  shielded_pool_health: GholaShieldedPoolHealth;
  evidence_chain?: GholaPrivateModeEvidenceChain | null;
  now?: Date;
}): GholaPrivateExecutionPlan {
  const now = input.now ?? new Date();
  const settlementKind = settlementKindFor(input.preview.selected_rail);
  const settlementRequired = settlementKind === "shielded_pool_withdraw" ||
    settlementKind === "shielded_batch" ||
    settlementKind === "shielded_batch_auction";
  const waitReasons = [...input.preview.wait_reasons];
  const blockedReasons = [...input.preview.blocked_reasons];
  const privateMode = isPrivateModeAvailableStatus(input.preview.claim_status);

  if (settlementRequired && input.shielded_pool_health.status !== "green") {
    waitReasons.push("shielded pool services are not green");
  }
  if (settlementRequired && input.shielded_pool_health.sealed_runtime.status !== "green") {
    waitReasons.push("sealed private runtime is not available");
  }
  if (privateMode && !input.evidence_chain?.batch_evidence_commitment) {
    waitReasons.push("batch evidence commitment is required before planning execution");
  }

  const status = input.preview.claim_status === "blocked_leaky_path" || blockedReasons.length
    ? "blocked"
    : input.preview.claim_status === "degraded_user_accepted_required"
      ? "degraded"
      : waitReasons.length
        ? "waiting"
        : "ready";
  const railSteps = railStepsFor(input.preview.selected_rail, status, waitReasons, blockedReasons);
  const evidenceChainCommitment = input.evidence_chain
    ? gholaCommitment("execution_plan_evidence_chain", input.evidence_chain)
    : null;
  const connectorContext = input.preview.connector_context;
  const runtimeContext = input.preview.sealed_runtime_context;
  const scheduleDecision = input.preview.schedule_decision;
  const rotation = input.preview.rotation;
  const simulation = input.preview.linkability_simulation;
  const planSeed = {
    preview_commitment: input.preview.preview_commitment,
    account_commitment: input.preview.account_commitment,
    action_commitment: input.preview.action_commitment,
    platform_class: input.preview.platform_class,
    selected_rail: input.preview.selected_rail,
    settlementKind,
    settlementRequired,
    status,
    rail_steps: railSteps,
    shielded_pool_health_commitment: shieldedHealthCommitment(input.shielded_pool_health),
    sealed_runtime_status: settlementRequired
      ? input.shielded_pool_health.sealed_runtime.status
      : "not_required",
    evidenceChainCommitment,
    connectorContext,
    runtimeContext,
    scheduleDecision,
    rotation,
    simulation,
    claimLevels: input.preview.claim_levels_achieved,
  };
  return {
    version: 1,
    plan_commitment: gholaCommitment("execution_plan", planSeed),
    preview_commitment: input.preview.preview_commitment,
    account_commitment: input.preview.account_commitment,
    action_commitment: input.preview.action_commitment,
    platform_class: input.preview.platform_class,
    selected_rail: input.preview.selected_rail,
    settlement_kind: settlementKind,
    settlement_required: settlementRequired,
    status,
    rail_steps: railSteps,
    shielded_pool_health_commitment: shieldedHealthCommitment(input.shielded_pool_health),
    sealed_runtime_status: settlementRequired
      ? input.shielded_pool_health.sealed_runtime.status
      : "not_required",
    evidence_chain_commitment: evidenceChainCommitment,
    manifest_commitment: connectorContext?.manifest_commitment ?? null,
    connector_readiness_commitment: connectorContext?.connector_readiness_commitment ?? null,
    compiler_commitment: connectorContext?.compiler_commitment ?? null,
    linkability_score_commitment: connectorContext?.linkability_score_commitment ?? null,
    sandbox_policy_commitment: connectorContext?.sandbox_policy_commitment ?? null,
    runtime_envelope_commitment: runtimeContext?.runtime_envelope_commitment ?? null,
    runtime_attestation_commitment: runtimeContext?.runtime_attestation_commitment ?? null,
    runtime_health_commitment: runtimeContext?.runtime_health_commitment ?? null,
    schedule_commitment: scheduleDecision?.schedule_commitment ?? null,
    rotation_commitment: rotation?.rotation_commitment ?? null,
    simulator_commitment: simulation?.simulator_commitment ?? null,
    claim_levels_achieved: input.preview.claim_levels_achieved,
    claim_levels_missing: input.preview.claim_levels_missing,
    wait_reasons: Array.from(new Set(waitReasons)),
    blocked_reasons: Array.from(new Set(blockedReasons)),
    created_at: now.toISOString(),
    expires_at: input.preview.expires_at,
  };
}

export async function settlePrivateExecutionPlan(input: {
  plan: GholaPrivateExecutionPlan;
  approval_commitment: string;
  execution_commitment: string;
  now?: Date;
}): Promise<
  | { ok: true; evidence: GholaShieldedSettlementEvidence }
  | { ok: false; error: GholaPrivateSettlementError }
> {
  const now = input.now ?? new Date();
  if (input.plan.status !== "ready") return { ok: false, error: "private_execution_plan_not_ready" };
  if (!input.plan.settlement_required) {
    return {
      ok: true,
      evidence: internalSettlementEvidence(input, now),
    };
  }

  const health = await shieldedPoolHealth(now);
  if (health.status !== "green") return { ok: false, error: "shielded_pool_unhealthy" };
  if (health.sealed_runtime.status !== "green") return { ok: false, error: "sealed_runtime_unavailable" };

  const config = shieldedPoolConfig();
  if (config.mode === "local_test") {
    return {
      ok: true,
      evidence: localSettlementEvidence(input, health.network, now),
    };
  }

  const runtimeEvidence = await sealedRuntimeSettlementEvidence(input, now);
  if (!runtimeEvidence) return { ok: false, error: "sealed_runtime_settlement_unavailable" };
  return { ok: true, evidence: runtimeEvidence };
}

export async function refreshShieldedSettlementEvidence(input: {
  evidence: GholaShieldedSettlementEvidence;
  now?: Date;
}): Promise<GholaShieldedSettlementEvidence> {
  const now = input.now ?? new Date();
  const config = shieldedPoolConfig();
  if (config.mode === "local_test" || !config.private_runtime_url) {
    return {
      ...input.evidence,
      lifecycle_status: "finalized",
      relay_status: relayStatusEvidence({
        relay_commitment: input.evidence.relay_status.relay_commitment,
        status: "finalized",
        now,
      }),
      finality_commitment: input.evidence.finality_commitment ||
        gholaCommitment("settlement_finality", {
          settlement_commitment: input.evidence.settlement_commitment,
        }),
      settled_at: now.toISOString(),
    };
  }

  try {
    const res = await fetch(new URL("/private-mode/settlement-status", config.private_runtime_url), {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        ...(config.private_runtime_token ? { authorization: `Bearer ${config.private_runtime_token}` } : {}),
      },
      body: JSON.stringify({
        settlement_commitment: input.evidence.settlement_commitment,
        execution_commitment: input.evidence.execution_commitment,
        relay_commitment: input.evidence.relay_status.relay_commitment,
      }),
    });
    const body = asRecord(await res.json().catch(() => null));
    if (!res.ok || body.ok === false) return input.evidence;
    const relayCommitment = stringValue(body.relay_commitment) ||
      input.evidence.relay_status.relay_commitment;
    const finalityCommitment = stringValue(body.finality_commitment) ||
      input.evidence.finality_commitment;
    const relayStatus = relayStatusValue(stringValue(body.relay_status)) ||
      input.evidence.relay_status.status;
    return {
      ...input.evidence,
      lifecycle_status: lifecycleStatusValue(stringValue(body.lifecycle_status)) ||
        input.evidence.lifecycle_status,
      relay_status: relayStatusEvidence({
        relay_commitment: relayCommitment,
        status: relayStatus,
        now,
      }),
      finality_commitment: finalityCommitment,
      settled_at: stringValue(body.settled_at) || input.evidence.settled_at,
    };
  } catch {
    return input.evidence;
  }
}

export function shieldedHealthCommitment(health: GholaShieldedPoolHealth): string {
  return gholaCommitment("shielded_pool_health", {
    status: health.status,
    mode: health.mode,
    network: health.network,
    program_commitment: health.program_commitment,
    mint_commitment: health.mint_commitment,
    tree_commitment: health.tree_commitment,
    indexer: health.indexer.commitment,
    tree_state: health.tree_state.commitment,
    prover: health.prover.commitment,
    relayer: health.relayer.commitment,
    sealed_runtime: health.sealed_runtime.commitment,
  });
}

function railStepsFor(
  selectedRail: GholaRailKind,
  status: GholaPrivateExecutionPlan["status"],
  waitReasons: string[],
  blockedReasons: string[],
): GholaPrivateRailStep[] {
  const order: GholaRailKind[] = [
    "private_state_only",
    "vault_omnibus_netting",
    "combined_vault_shielded_batch",
    "shielded_batch_auction",
    "shielded_pool",
    "confidential_token",
    "provider_omnibus_subaccount",
    "private_relayer",
    "stealth_change_address",
    "direct_public_fallback",
  ];
  return order.map((rail) => {
    const stepStatus = rail === selectedRail
      ? status === "blocked"
        ? "blocked"
        : "selected"
      : order.indexOf(rail) < order.indexOf(selectedRail)
        ? "skipped"
        : "planned";
    const reason = rail === selectedRail
      ? blockedReasons[0] ?? waitReasons[0] ?? null
      : null;
    return {
      version: 1,
      step_commitment: gholaCommitment("rail_step", { rail, stepStatus, reason }),
      rail,
      status: stepStatus,
      reason,
    };
  });
}

function settlementKindFor(rail: GholaRailKind): GholaPrivateExecutionPlan["settlement_kind"] {
  if (rail === "private_state_only") return "internal_private_state";
  if (rail === "vault_omnibus_netting") return "vault_netting";
  if (rail === "shielded_batch_auction") return "shielded_batch_auction";
  if (rail === "combined_vault_shielded_batch") return "shielded_batch";
  if (rail === "shielded_pool") return "shielded_pool_withdraw";
  return "none";
}

function internalSettlementEvidence(
  input: {
    plan: GholaPrivateExecutionPlan;
    approval_commitment: string;
    execution_commitment: string;
  },
  now: Date,
): GholaShieldedSettlementEvidence {
  return localSettlementEvidence(input, shieldedPoolConfig().network, now);
}

async function sealedRuntimeSettlementEvidence(
  input: {
    plan: GholaPrivateExecutionPlan;
    approval_commitment: string;
    execution_commitment: string;
  },
  now: Date,
): Promise<GholaShieldedSettlementEvidence | null> {
  const config = shieldedPoolConfig();
  if (config.mode === "local_test" || !config.private_runtime_url) return null;
  try {
    const res = await fetch(new URL("/private-mode/settle", config.private_runtime_url), {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        ...(config.private_runtime_token ? { authorization: `Bearer ${config.private_runtime_token}` } : {}),
      },
      body: JSON.stringify({
        plan_commitment: input.plan.plan_commitment,
        preview_commitment: input.plan.preview_commitment,
        approval_commitment: input.approval_commitment,
        execution_commitment: input.execution_commitment,
      }),
    });
    const body = asRecord(await res.json().catch(() => null));
    if (!res.ok || body.ok === false) return null;

    const proofCommitment = stringValue(body.proof_commitment);
    const witnessCommitment = stringValue(body.witness_commitment);
    const relayCommitment = stringValue(body.relay_commitment);
    const finalityCommitment = stringValue(body.finality_commitment);
    if (!proofCommitment || !witnessCommitment || !relayCommitment || !finalityCommitment) {
      return null;
    }

    const attestation = parseAttestation(body, now);
    if (body.attestation_commitment && !attestation) return null;
    return evidenceFromCommitments({
      input,
      now,
      network: stringValue(body.network) || config.network,
      root_commitment: stringValue(body.root_commitment) || null,
      proof_commitment: proofCommitment,
      witness_commitment: witnessCommitment,
      relay_commitment: relayCommitment,
      finality_commitment: finalityCommitment,
      relay_status: relayStatusValue(stringValue(body.relay_status)) || "unknown",
      lifecycle_status: lifecycleStatusValue(stringValue(body.lifecycle_status)) || "finality_pending",
      attestation,
    });
  } catch {
    return null;
  }
}

function localSettlementEvidence(
  input: {
    plan: GholaPrivateExecutionPlan;
    approval_commitment: string;
    execution_commitment: string;
  },
  network: string,
  now: Date,
): GholaShieldedSettlementEvidence {
  return evidenceFromCommitments({
    input,
    now,
    network,
    root_commitment: gholaCommitment("settlement_root", {
      plan_commitment: input.plan.plan_commitment,
      execution_commitment: input.execution_commitment,
    }),
    proof_commitment: gholaCommitment("settlement_proof", {
      plan_commitment: input.plan.plan_commitment,
      execution_commitment: input.execution_commitment,
    }),
    witness_commitment: gholaCommitment("settlement_witness", {
      plan_commitment: input.plan.plan_commitment,
      execution_commitment: input.execution_commitment,
    }),
    relay_commitment: gholaCommitment("settlement_relay", {
      plan_commitment: input.plan.plan_commitment,
      execution_commitment: input.execution_commitment,
    }),
    finality_commitment: gholaCommitment("settlement_finality", {
      plan_commitment: input.plan.plan_commitment,
      execution_commitment: input.execution_commitment,
    }),
    relay_status: "finalized",
    lifecycle_status: "finalized",
    attestation: null,
  });
}

function evidenceFromCommitments(input: {
  input: {
    plan: GholaPrivateExecutionPlan;
    approval_commitment: string;
    execution_commitment: string;
  };
  now: Date;
  network: string;
  root_commitment: string | null;
  proof_commitment: string;
  witness_commitment: string;
  relay_commitment: string;
  finality_commitment: string;
  relay_status: GholaRelayStatusEvidence["status"];
  lifecycle_status: GholaPrivateSettlementLifecycleStatus;
  attestation: GholaRuntimeAttestationEvidence | null;
}): GholaShieldedSettlementEvidence {
  const relayStatus = relayStatusEvidence({
    relay_commitment: input.relay_commitment,
    status: input.relay_status,
    now: input.now,
  });
  return {
    version: 1,
    settlement_commitment: gholaCommitment("settlement", {
      plan_commitment: input.input.plan.plan_commitment,
      preview_commitment: input.input.plan.preview_commitment,
      approval_commitment: input.input.approval_commitment,
      execution_commitment: input.input.execution_commitment,
      root_commitment: input.root_commitment,
      proof_commitment: input.proof_commitment,
      witness_commitment: input.witness_commitment,
      relay_commitment: input.relay_commitment,
      finality_commitment: input.finality_commitment,
      attestation_commitment: input.attestation?.attestation_commitment ?? null,
      lifecycle_status: input.lifecycle_status,
    }),
    execution_plan_commitment: input.input.plan.plan_commitment,
    preview_commitment: input.input.plan.preview_commitment,
    approval_commitment: input.input.approval_commitment,
    execution_commitment: input.input.execution_commitment,
    rail: input.input.plan.selected_rail,
    network: input.network,
    lifecycle_status: input.lifecycle_status,
    root_commitment: input.root_commitment,
    proof_commitment: input.proof_commitment,
    witness_commitment: input.witness_commitment,
    attestation: input.attestation,
    attestation_commitment: input.attestation?.attestation_commitment ?? null,
    relay_status: relayStatus,
    finality_commitment: input.finality_commitment,
    settled_at: input.now.toISOString(),
  };
}

function relayStatusEvidence(input: {
  relay_commitment: string;
  status: GholaRelayStatusEvidence["status"];
  now: Date;
}): GholaRelayStatusEvidence {
  return {
    version: 1,
    relay_commitment: input.relay_commitment,
    status_commitment: gholaCommitment("relay_status", {
      relay_commitment: input.relay_commitment,
      status: input.status,
      observed_at: input.now.toISOString(),
    }),
    status: input.status,
    observed_at: input.now.toISOString(),
  };
}

function parseAttestation(
  body: Record<string, unknown>,
  now: Date,
): GholaRuntimeAttestationEvidence | null {
  const attestationCommitment = stringValue(body.attestation_commitment);
  const runtimeCommitment = stringValue(body.runtime_commitment);
  const measurementCommitment = stringValue(body.measurement_commitment);
  const policyCommitment = stringValue(body.policy_commitment);
  if (!attestationCommitment && !runtimeCommitment && !measurementCommitment && !policyCommitment) {
    return null;
  }
  if (!attestationCommitment || !runtimeCommitment || !measurementCommitment || !policyCommitment) {
    return null;
  }
  const expectedMeasurement = process.env.GHOLA_PRIVATE_RUNTIME_MEASUREMENT_COMMITMENT?.trim();
  const expectedRuntime = process.env.GHOLA_PRIVATE_RUNTIME_COMMITMENT?.trim();
  if (expectedMeasurement && expectedMeasurement !== measurementCommitment) return null;
  if (expectedRuntime && expectedRuntime !== runtimeCommitment) return null;
  return {
    version: 1,
    attestation_commitment: attestationCommitment,
    runtime_commitment: runtimeCommitment,
    measurement_commitment: measurementCommitment,
    policy_commitment: policyCommitment,
    status: body.attestation_status === "red" ? "red" : "green",
    observed_at: stringValue(body.attestation_observed_at) || now.toISOString(),
  };
}

function relayStatusValue(value: string): GholaRelayStatusEvidence["status"] | null {
  return value === "accepted" || value === "finalized" || value === "failed" || value === "unknown"
    ? value
    : null;
}

function lifecycleStatusValue(value: string): GholaPrivateSettlementLifecycleStatus | null {
  return value === "planned" ||
    value === "proof_requested" ||
    value === "proof_ready" ||
    value === "relay_submitted" ||
    value === "finality_pending" ||
    value === "finalized" ||
    value === "failed" ||
    value === "expired"
    ? value
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
