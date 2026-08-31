import { NextRequest, NextResponse } from "next/server";
import { sameOrigin } from "@/app/api/auth/session/_lib";
import {
  privateAccountOwnerFromRequest,
  unauthorized,
} from "../_lib";
import {
  workerAuthorizationHeader,
  workerCapabilitySecret,
} from "@/lib/private-agent-capability";
import { agentPassportVenueAccessForWorker } from "@/lib/private-agent-passport";
import { verifyCarryPrivatePrimeWorkerAuthentication } from "@/lib/carry-private-prime-worker-authentication";
import { verifyCarryCreationOpportunityWorkerAuthentication } from "@/lib/carry-creation-opportunity-authentication";
import { verifyCarryPortfolioValueWorkerAuthentication } from "@/lib/carry-portfolio-value-worker-authentication";
import { verifyCarryReleaseMaterialWorkerAuthentication } from "@/lib/carry-release-material-worker-authentication";
import { buildCarryNoSubmitEvidence } from "@/lib/carry-no-submit-evidence";
import { randomUUID } from "node:crypto";
import { normalizeCarryShadowAssets } from "@ghola/execution-core";
import { CARRY_EXECUTION_VENUES, isCarryExecutionVenue } from "@/lib/carry-venues";
import { verifyCarryRiskMandateAuthorization } from "@/lib/carry-risk-mandate";
import {
  resolveCarryShadowWorkerUrl,
  resolvePrivateAgentWorkerUrl,
} from "@/lib/private-account-worker-routing";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store, max-age=0" };

export async function GET(req: NextRequest) {
  const worker = carryShadowWorkerConfig();
  if (!worker.url) return response({ error: "carry_worker_unavailable" }, 503);
  const assets = normalizeCarryShadowAssets(req.nextUrl.searchParams.get("assets"), { default_to_all: true });
  if (!assets) return response({ error: "carry_shadow_assets_invalid" }, 400);
  const target = new URL("/carry/shadow", worker.url);
  target.searchParams.set("assets", assets.join(","));
  try {
    const upstream = await fetch(target, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    return response(await upstream.json().catch(() => ({ error: "carry_shadow_invalid" })), upstream.status);
  } catch {
    return response({ error: "carry_worker_unavailable" }, 503);
  }
}

function carryShadowWorkerConfig() {
  const raw = resolveCarryShadowWorkerUrl({
    shadow_url: process.env.GHOLA_CARRY_SHADOW_WORKER_URL,
    connector_url: process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL,
    execution_url: process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL || process.env.PRIVATE_AGENT_EXECUTION_URL,
    worker_url: process.env.GHOLA_PRIVATE_AGENT_WORKER_URL || process.env.PRIVATE_AGENT_WORKER_URL,
    phala_endpoint: process.env.PHALA_AGENT_ENDPOINT,
  });
  return { url: parseWorkerUrl(raw) };
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const correlationId = requestCorrelationId(req);
  if (!sameOrigin(req)) return response({ error: "cross_site_request_rejected" }, 403, correlationId);
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const worker = workerConfig();
  if (!worker.url) return response({ error: "carry_worker_unavailable" }, 503, correlationId);
  const input = await req.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) return response({ error: "carry_request_invalid" }, 400, correlationId);
  const action = typeof input.action === "string" ? input.action : "";
  const route = carryRoute(action);
  if (!route) return response({ error: "carry_action_invalid" }, 400, correlationId);
  console.info("[carry] request started", {
    correlation_id: correlationId,
    action,
    operation_class: route.operationClass,
    no_submit: action.startsWith("preflight_") || ["readiness", "observe", "capital_plan", "collateral_review", "approve_collateral_review", "value_report", "release_evidence"].includes(action),
  });
  let body: Record<string, unknown> = {
    ...input,
    action: undefined,
    owner_commitment: owner.owner_commitment,
  };
  if (action === "preflight_aster") {
    const access = record((await agentPassportVenueAccessForWorker(owner)).aster);
    if (access.status !== "ready") return response({ error: "aster_account_not_ready" }, 409, correlationId);
    body = {
      version: 1,
      owner_commitment: owner.owner_commitment,
      account_commitment: access.account_commitment,
      venue_id: "aster",
      platform_class: "hyperliquid_style_market",
      execution_mode: "byo_api_key",
      operation_class: "limit_order",
      work_order_commitment: `carry_preflight_${randomUUID()}`,
      vault_commitment: access.vault_commitment,
      encrypted_vault_commitment: access.encrypted_vault_commitment,
      policy_commitment: access.policy_commitment,
      encrypted_execution_vault: access.encrypted_execution_vault,
      market: input.market,
      side: input.side,
      base_size: input.base_size,
      limit_price: input.limit_price,
      max_notional_bucket: input.max_notional_bucket || "25",
    };
  }
  if (action === "preflight_hyperliquid") {
    const access = record((await agentPassportVenueAccessForWorker(owner)).hyperliquid);
    if (access.status !== "ready") return response({ error: "hyperliquid_account_not_ready" }, 409, correlationId);
    body = {
      version: 1,
      owner_commitment: owner.owner_commitment,
      account_commitment: access.account_commitment,
      venue_id: "hyperliquid",
      platform_class: "hyperliquid_style_market",
      execution_mode: "byo_api_key",
      operation_class: "limit_order",
      work_order_commitment: `carry_preflight_${randomUUID()}`,
      vault_commitment: access.vault_commitment,
      encrypted_vault_commitment: access.encrypted_vault_commitment,
      policy_commitment: access.policy_commitment,
      encrypted_execution_vault: access.encrypted_execution_vault,
      market: input.market,
      side: input.side,
      quote_size: input.quote_size,
      max_slippage_bps: input.max_slippage_bps || "50",
      max_notional_bucket: input.max_notional_bucket || "25",
    };
  }
  if (action === "preflight_lighter") {
    const access = record((await agentPassportVenueAccessForWorker(owner)).lighter);
    if (access.status !== "ready") return response({ error: "lighter_account_not_ready" }, 409, correlationId);
    body = {
      version: 1,
      owner_commitment: owner.owner_commitment,
      account_commitment: access.account_commitment,
      venue_id: "lighter",
      platform_class: "hyperliquid_style_market",
      execution_mode: "byo_api_key",
      operation_class: "limit_order",
      work_order_commitment: `carry_preflight_${randomUUID()}`,
      vault_commitment: access.vault_commitment,
      encrypted_vault_commitment: access.encrypted_vault_commitment,
      policy_commitment: access.policy_commitment,
      encrypted_execution_vault: access.encrypted_execution_vault,
      market: input.market,
      side: input.side,
      base_size: input.base_size,
      limit_price: input.limit_price,
      max_notional_bucket: input.max_notional_bucket || "25",
    };
  }
  if (action === "preflight_pair") {
    const venueAccess = await agentPassportVenueAccessForWorker(owner);
    const longVenue = stringValue(input.long_venue_id);
    const shortVenue = stringValue(input.short_venue_id);
    if (!isCarryExecutionVenue(longVenue) || !isCarryExecutionVenue(shortVenue)) {
      return response({ error: "carry_venue_pair_invalid" }, 400, correlationId);
    }
    const selected = [longVenue, shortVenue];
    const accesses = Object.fromEntries(selected.map((venueId) => [venueId, record(venueAccess[venueId as keyof typeof venueAccess])]));
    for (const venueId of selected) {
      if (accesses[venueId].status !== "ready") return response({ error: `${venueId}_account_not_ready` }, 409, correlationId);
    }
    body = {
      version: 1,
      owner_commitment: owner.owner_commitment,
      operation_class: "paired_no_submit",
      work_order_commitment: `carry_pair_preflight_${randomUUID()}`,
      asset: input.asset,
      long_venue_id: input.long_venue_id,
      short_venue_id: input.short_venue_id,
      notional_usd: input.notional_usd,
      horizon_days: input.horizon_days,
      venue_access: {
        ...Object.fromEntries(selected.map((venueId) => [venueId, workerVenueAccess(accesses[venueId], owner.owner_commitment)])),
      },
    };
  }
  if (action === "preflight_matrix") {
    const venueAccess = await agentPassportVenueAccessForWorker(owner);
    const accesses = Object.fromEntries(CARRY_EXECUTION_VENUES.map((venueId) => [venueId, record(venueAccess[venueId])]));
    const selectedLongVenue = stringValue(input.selected_long_venue_id) || "";
    const selectedShortVenue = stringValue(input.selected_short_venue_id) || "";
    const selectedPairProvided = selectedLongVenue.length > 0 || selectedShortVenue.length > 0;
    if (selectedPairProvided && (!isCarryExecutionVenue(selectedLongVenue)
      || !isCarryExecutionVenue(selectedShortVenue)
      || selectedLongVenue === selectedShortVenue)) {
      return response({ error: "carry_selected_venue_pair_invalid" }, 400, correlationId);
    }
    body = {
      version: 1,
      owner_commitment: owner.owner_commitment,
      operation_class: "matrix_no_submit",
      work_order_commitment: `carry_matrix_preflight_${randomUUID()}`,
      asset: input.asset,
      notional_usd: input.notional_usd,
      horizon_days: input.horizon_days,
      ...(selectedPairProvided ? {
        selected_long_venue_id: selectedLongVenue,
        selected_short_venue_id: selectedShortVenue,
      } : {}),
      venue_access: Object.fromEntries(CARRY_EXECUTION_VENUES.map((venueId) => [
        venueId,
        workerMatrixVenueAccess(accesses[venueId], owner.owner_commitment),
      ])),
    };
  }
  if (action === "readiness") {
    const venueAccess = await agentPassportVenueAccessForWorker(owner);
    const accesses = Object.fromEntries(CARRY_EXECUTION_VENUES.map((venueId) => [venueId, record(venueAccess[venueId])]));
    body = {
      version: 1,
      owner_commitment: owner.owner_commitment,
      operation_class: "readiness_read",
      work_order_commitment: `carry_readiness_${randomUUID()}`,
      asset: input.asset,
      notional_usd: input.notional_usd,
      horizon_days: input.horizon_days,
      venue_access: Object.fromEntries(CARRY_EXECUTION_VENUES.map((venueId) => [
        venueId,
        workerMatrixVenueAccess(accesses[venueId], owner.owner_commitment),
      ])),
    };
  }
  if (action === "create") {
    const positionInput = record(input.position_input);
    const longVenue = stringValue(positionInput.long_venue_id);
    const shortVenue = stringValue(positionInput.short_venue_id);
    if (!isCarryExecutionVenue(longVenue) || !isCarryExecutionVenue(shortVenue) || longVenue === shortVenue) {
      return response({ error: "carry_venue_pair_invalid" }, 400, correlationId);
    }
    const venueAccess = await agentPassportVenueAccessForWorker(owner);
    const selected = [longVenue, shortVenue];
    const riskMandate = record(positionInput.risk_mandate);
    const migrationVenues = riskMandate.allow_migration === true && Array.isArray(riskMandate.migration_venue_allowlist)
      ? riskMandate.migration_venue_allowlist.filter((venueId): venueId is string =>
          typeof venueId === "string" && isCarryExecutionVenue(venueId))
      : [];
    const permitted = [...new Set([...CARRY_EXECUTION_VENUES, ...migrationVenues])];
    const accesses = Object.fromEntries(permitted.map((venueId) => [venueId, record(venueAccess[venueId as keyof typeof venueAccess])]));
    for (const venueId of selected) {
      if (accesses[venueId].status !== "ready") return response({ error: `${venueId}_account_not_ready` }, 409, correlationId);
    }
    const mandate = await verifyCarryRiskMandateAuthorization({
      owner_commitment: owner.owner_commitment,
      position_input: positionInput,
      mandate_authorization: positionInput.mandate_authorization,
    });
    if (!mandate.ok) return response({ error: mandate.error }, 403, correlationId);
    body = {
      version: 1,
      owner_commitment: owner.owner_commitment,
      policy_commitment: mandate.authorization.mandate_commitment,
      position_input: {
        ...positionInput,
        mandate_authorization: mandate.authorization,
      },
      opportunity: input.opportunity,
      qualification_pilot: input.qualification_pilot,
      monitoring_context: {
        version: 1,
        venue_access: Object.fromEntries(permitted
          .filter((venueId) => accesses[venueId].status === "ready")
          .map((venueId) => [venueId, workerVenueAccess(accesses[venueId], owner.owner_commitment)])),
      },
    };
  }
  if (action === "observe") {
    const longVenue = stringValue(input.long_venue_id);
    const shortVenue = stringValue(input.short_venue_id);
    if (!isCarryExecutionVenue(longVenue) || !isCarryExecutionVenue(shortVenue) || longVenue === shortVenue) {
      return response({ error: "carry_venue_pair_invalid" }, 400, correlationId);
    }
    const venueAccess = await agentPassportVenueAccessForWorker(owner);
    const selected = [longVenue, shortVenue];
    const accesses = Object.fromEntries(selected.map((venueId) => [venueId, record(venueAccess[venueId as keyof typeof venueAccess])]));
    for (const venueId of selected) {
      if (accesses[venueId].status !== "ready") return response({ error: `${venueId}_account_not_ready` }, 409, correlationId);
    }
    body = {
      version: 1,
      owner_commitment: owner.owner_commitment,
      position_id: input.position_id,
      venue_access: Object.fromEntries(selected.map((venueId) => [venueId, workerVenueAccess(accesses[venueId], owner.owner_commitment)])),
    };
  }
  if (["capital_plan", "collateral_review", "value_report"].includes(action)) {
    body = {
      version: 1,
      owner_commitment: owner.owner_commitment,
      owner_capital_budget_micro_usdc: input.owner_capital_budget_micro_usdc,
      max_data_age_ms: input.max_data_age_ms,
      minimum_transfer_arrival_buffer_ms: input.minimum_transfer_arrival_buffer_ms,
    };
  }
  if (action === "approve_collateral_review") {
    body = {
      version: 1,
      owner_commitment: owner.owner_commitment,
      authorization: input.authorization,
    };
  }
  if (action === "release_evidence") {
    body = {
      version: 1,
      owner_commitment: owner.owner_commitment,
      position_id: input.position_id,
    };
  }
  const authorization = workerAuthorizationHeader({
    fallbackToken: worker.token,
    method: "POST",
    path: route.path,
    scope: route.scope,
    body,
      expected: {
        owner_commitment: owner.owner_commitment,
        account_commitment: body.account_commitment,
        venue_id: body.venue_id,
        platform_class: body.platform_class,
        operation_class: route.operationClass,
        work_order_commitment: body.work_order_commitment,
        policy_commitment: body.policy_commitment,
        vault_commitment: body.vault_commitment,
      },
  });
  if (!authorization) {
    return response({ error: "carry_worker_authorization_misconfigured" }, 503, correlationId);
  }
  try {
    const upstream = await fetch(new URL(route.path, worker.url), {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
      headers: {
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        ...(action.startsWith("preflight_") || action === "readiness" || action === "observe" || action === "capital_plan" || action === "collateral_review" || action === "approve_collateral_review" || action === "value_report" || action === "release_evidence" ? { "x-ghola-no-submit-verify": "true" } : {}),
        ...(action === "execute_entry" ? { "x-ghola-live-order-confirmed": "true" } : {}),
        ...(action === "create" && record(input.qualification_pilot).enabled === true ? { "x-ghola-carry-qualification-planned": "true" } : {}),
        ...(action === "execute_entry" && input.qualification_pilot_confirmed === true ? { "x-ghola-carry-qualification-confirmed": "true" } : {}),
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    });
    const result = await upstream.json().catch(() => ({ error: "carry_worker_invalid" }));
    if (!upstream.ok && workerAuthorizationRejected(upstream.status, result)) {
      return response({ error: "carry_worker_authorization_misconfigured" }, 503, correlationId);
    }
    if (upstream.ok && action === "preflight_pair") {
      const authenticated = verifyCarryCreationOpportunityWorkerAuthentication({
        owner_commitment: owner.owner_commitment,
        opportunity: record(record(result).creation_opportunity),
      });
      if (!authenticated.ok) {
        console.error("[carry] creation-opportunity worker authentication failed", {
          correlation_id: correlationId,
          action,
          operation_class: route.operationClass,
          duration_ms: Date.now() - startedAt,
        });
        return response({ error: authenticated.error }, 502, correlationId);
      }
    }
    if (upstream.ok && (action === "preflight_matrix" || action === "readiness")) {
      const authenticated = verifyCarryPrivatePrimeWorkerAuthentication({
        route_path: route.path,
        body,
        response: result,
        secret: workerCapabilitySecret(process.env) || worker.token,
      });
      if (!authenticated.ok) {
        console.error("[carry] private-prime worker authentication failed", {
          correlation_id: correlationId,
          action,
          operation_class: route.operationClass,
          duration_ms: Date.now() - startedAt,
        });
        return response({ error: authenticated.error }, 502, correlationId);
      }
      if (action === "preflight_matrix" && body.selected_long_venue_id && body.selected_short_venue_id) {
        const selectedPair = record(record(result).selected_pair);
        if (selectedPair.long_venue_id !== body.selected_long_venue_id
          || selectedPair.short_venue_id !== body.selected_short_venue_id
          || selectedPair.transaction_broadcast !== false) {
          return response({ error: "carry_selected_pair_worker_binding_invalid" }, 502, correlationId);
        }
        const selectedResult = record(selectedPair.result);
        if (Object.keys(selectedResult).length > 0) {
          const selectedAuthenticated = verifyCarryCreationOpportunityWorkerAuthentication({
            owner_commitment: owner.owner_commitment,
            opportunity: record(selectedResult.creation_opportunity),
          });
          if (!selectedAuthenticated.ok) {
            return response({ error: selectedAuthenticated.error }, 502, correlationId);
          }
        } else if (!stringValue(selectedPair.error_code)) {
          return response({ error: "carry_selected_pair_worker_binding_invalid" }, 502, correlationId);
        }
      }
    }
    if (upstream.ok && action === "value_report") {
      const authenticated = verifyCarryPortfolioValueWorkerAuthentication({
        route_path: route.path,
        body,
        response: result,
      });
      if (!authenticated.ok) {
        console.error("[carry] portfolio-value worker authentication failed", {
          correlation_id: correlationId,
          action,
          operation_class: route.operationClass,
          duration_ms: Date.now() - startedAt,
        });
        return response({ error: authenticated.error }, 502, correlationId);
      }
    }
    if (upstream.ok && action === "release_evidence") {
      const authenticated = verifyCarryReleaseMaterialWorkerAuthentication({
        route_path: route.path,
        body,
        response: result,
      });
      if (!authenticated.ok) {
        console.error("[carry] release-material worker authentication failed", {
          correlation_id: correlationId,
          action,
          operation_class: route.operationClass,
          duration_ms: Date.now() - startedAt,
        });
        return response({ error: authenticated.error }, 502, correlationId);
      }
    }
    const publicResult = upstream.ok && action === "preflight_matrix"
      ? attachNoSubmitEvidence(body, result)
      : result;
    console.info("[carry] request completed", {
      correlation_id: correlationId,
      action,
      operation_class: route.operationClass,
      status: upstream.status,
      duration_ms: Date.now() - startedAt,
    });
    return response(publicResult, upstream.status, correlationId);
  } catch (error) {
    console.error("[carry] request failed", {
      correlation_id: correlationId,
      action,
      operation_class: route.operationClass,
      duration_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return response({ error: "carry_worker_unavailable" }, 503, correlationId);
  }
}

function carryRoute(action: string) {
  if (action === "preflight_pair") return { path: "/carry/preflight", scope: "carry:read" as const, operationClass: "paired_no_submit" };
  if (action === "preflight_matrix") return { path: "/carry/preflight-matrix", scope: "carry:read" as const, operationClass: "matrix_no_submit" };
  if (action === "readiness") return { path: "/carry/readiness", scope: "carry:read" as const, operationClass: "readiness_read" };
  if (action === "preflight_aster") return { path: "/venues/aster/preflight", scope: "order:verify" as const, operationClass: "limit_order" };
  if (action === "preflight_hyperliquid") return { path: "/hyperliquid/preflight", scope: "order:verify" as const, operationClass: "limit_order" };
  if (action === "preflight_lighter") return { path: "/venues/lighter/preflight", scope: "order:verify" as const, operationClass: "limit_order" };
  if (action === "create") return { path: "/carry/positions", scope: "carry:write" as const, operationClass: "create" };
  if (action === "read") return { path: "/carry/positions/read", scope: "carry:read" as const, operationClass: "/read" };
  if (action === "capital_plan") return { path: "/carry/positions/capital-plan", scope: "carry:read" as const, operationClass: "/capital-plan" };
  if (action === "collateral_review") return { path: "/carry/positions/collateral-review", scope: "carry:read" as const, operationClass: "/collateral-review" };
  if (action === "approve_collateral_review") return { path: "/carry/positions/collateral-review/approve", scope: "carry:write" as const, operationClass: "/collateral-review/approve" };
  if (action === "value_report") return { path: "/carry/positions/value-report", scope: "carry:read" as const, operationClass: "/value-report" };
  if (action === "release_evidence") return { path: "/carry/positions/release-evidence", scope: "carry:read" as const, operationClass: "/release-evidence" };
  if (action === "request_exit") return { path: "/carry/positions/exit-request", scope: "carry:write" as const, operationClass: "/exit-request" };
  if (action === "observe") return { path: "/carry/positions/observe", scope: "carry:write" as const, operationClass: "/observe" };
  if (action === "execute_entry") return { path: "/carry/positions/execute-entry", scope: "order:submit" as const, operationClass: "/execute-entry" };
  return null;
}

function attachNoSubmitEvidence(request: Record<string, unknown>, workerResponse: unknown) {
  const result = buildCarryNoSubmitEvidence({ request, response: workerResponse });
  return result.ok
    ? { ...record(workerResponse), no_submit_evidence_status: "captured", no_submit_evidence: result.evidence }
    : { ...record(workerResponse), no_submit_evidence_status: result.error };
}

function workerVenueAccess(access: Record<string, unknown>, ownerCommitment: string) {
  return {
    status: "ready",
    owner_commitment: ownerCommitment,
    account_commitment: access.account_commitment,
    vault_commitment: access.vault_commitment,
    encrypted_vault_commitment: access.encrypted_vault_commitment,
    policy_commitment: access.policy_commitment,
    encrypted_execution_vault: access.encrypted_execution_vault,
  };
}

function workerMatrixVenueAccess(access: Record<string, unknown>, ownerCommitment: string) {
  if (access.status === "ready") return workerVenueAccess(access, ownerCommitment);
  return {
    status: "not_ready",
    owner_commitment: ownerCommitment,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function workerAuthorizationRejected(status: number, value: unknown) {
  if (status !== 401 && status !== 403 && status !== 503) return false;
  const code = stringValue(record(value).error_code) || stringValue(record(value).error) || "";
  return code === "unauthorized" || code.startsWith("worker_capability_");
}

function workerConfig() {
  const raw = resolvePrivateAgentWorkerUrl({
    connector_url: process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL,
    execution_url: process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL || process.env.PRIVATE_AGENT_EXECUTION_URL,
    worker_url: process.env.GHOLA_PRIVATE_AGENT_WORKER_URL || process.env.PRIVATE_AGENT_WORKER_URL,
    phala_endpoint: process.env.PHALA_AGENT_ENDPOINT,
  });
  return {
    url: parseWorkerUrl(raw),
    token: process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN?.trim() ||
      process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
      process.env.PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
      process.env.PRIVATE_AGENT_WORKER_TOKEN?.trim() || "",
  };
}

function parseWorkerUrl(raw: string) {
  try {
    return raw ? new URL(raw) : null;
  } catch {
    return null;
  }
}

function requestCorrelationId(req: NextRequest) {
  const supplied = req.headers.get("x-ghola-correlation-id")?.trim();
  return supplied && /^ghola-[a-zA-Z0-9-]{8,96}$/.test(supplied)
    ? supplied
    : `ghola-${randomUUID()}`;
}

function response(body: unknown, status = 200, correlationId?: string) {
  return NextResponse.json(body, {
    status,
    headers: {
      ...NO_STORE,
      ...(correlationId ? { "x-ghola-correlation-id": correlationId } : {}),
    },
  });
}
