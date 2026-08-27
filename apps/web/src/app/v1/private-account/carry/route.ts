import { NextRequest, NextResponse } from "next/server";
import { sameOrigin } from "@/app/api/auth/session/_lib";
import {
  privateAccountOwnerFromRequest,
  unauthorized,
} from "../_lib";
import { workerAuthorizationHeader } from "@/lib/private-agent-capability";
import { agentPassportVenueAccessForWorker } from "@/lib/private-agent-passport";
import { randomUUID } from "node:crypto";
import { CARRY_EXECUTION_VENUES, isCarryExecutionVenue } from "@/lib/carry-venues";
import { verifyCarryRiskMandateAuthorization } from "@/lib/carry-risk-mandate";
import { resolvePrivateAgentWorkerUrl } from "@/lib/private-account-worker-routing";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store, max-age=0" };

export async function GET(req: NextRequest) {
  const worker = workerConfig();
  if (!worker.url) return response({ error: "carry_worker_unavailable" }, 503);
  const assets = req.nextUrl.searchParams.get("assets") || "BTC,ETH,SOL";
  const target = new URL("/carry/shadow", worker.url);
  target.searchParams.set("assets", assets);
  try {
    const upstream = await fetch(target, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    return response(await upstream.json().catch(() => ({ error: "carry_shadow_invalid" })), upstream.status);
  } catch {
    return response({ error: "carry_worker_unavailable" }, 503);
  }
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
    no_submit: action.startsWith("preflight_") || action === "readiness",
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
    for (const venueId of CARRY_EXECUTION_VENUES) {
      if (accesses[venueId].status !== "ready") return response({ error: `${venueId}_account_not_ready` }, 409, correlationId);
    }
    body = {
      version: 1,
      owner_commitment: owner.owner_commitment,
      operation_class: "matrix_no_submit",
      work_order_commitment: `carry_matrix_preflight_${randomUUID()}`,
      asset: input.asset,
      notional_usd: input.notional_usd,
      horizon_days: input.horizon_days,
      venue_access: Object.fromEntries(CARRY_EXECUTION_VENUES.map((venueId) => [
        venueId,
        workerVenueAccess(accesses[venueId], owner.owner_commitment),
      ])),
    };
  }
  if (action === "readiness") {
    const venueAccess = await agentPassportVenueAccessForWorker(owner);
    const accesses = Object.fromEntries(CARRY_EXECUTION_VENUES.map((venueId) => [venueId, record(venueAccess[venueId])]));
    for (const venueId of CARRY_EXECUTION_VENUES) {
      if (accesses[venueId].status !== "ready") return response({ error: `${venueId}_account_not_ready` }, 409, correlationId);
    }
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
        workerVenueAccess(accesses[venueId], owner.owner_commitment),
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
    const permitted = [...new Set([...selected, ...migrationVenues])];
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
  try {
    const upstream = await fetch(new URL(route.path, worker.url), {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
      headers: {
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        ...(action.startsWith("preflight_") || action === "readiness" || action === "observe" || action === "capital_plan" || action === "value_report" ? { "x-ghola-no-submit-verify": "true" } : {}),
        ...(action === "execute_entry" ? { "x-ghola-live-order-confirmed": "true" } : {}),
        ...(action === "create" && record(input.qualification_pilot).enabled === true ? { "x-ghola-carry-qualification-planned": "true" } : {}),
        ...(action === "execute_entry" && input.qualification_pilot_confirmed === true ? { "x-ghola-carry-qualification-confirmed": "true" } : {}),
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    });
    const result = await upstream.json().catch(() => ({ error: "carry_worker_invalid" }));
    console.info("[carry] request completed", {
      correlation_id: correlationId,
      action,
      operation_class: route.operationClass,
      status: upstream.status,
      duration_ms: Date.now() - startedAt,
    });
    return response(result, upstream.status, correlationId);
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
  if (action === "value_report") return { path: "/carry/positions/value-report", scope: "carry:read" as const, operationClass: "/value-report" };
  if (action === "release_evidence") return { path: "/carry/positions/release-evidence", scope: "carry:read" as const, operationClass: "/release-evidence" };
  if (action === "event") return { path: "/carry/positions/events", scope: "carry:write" as const, operationClass: "/events" };
  if (action === "observe") return { path: "/carry/positions/observe", scope: "carry:write" as const, operationClass: "/observe" };
  if (action === "execute_entry") return { path: "/carry/positions/execute-entry", scope: "order:submit" as const, operationClass: "/execute-entry" };
  if (action === "value_entry") return { path: "/carry/positions/value-entries", scope: "carry:write" as const, operationClass: "/value-entries" };
  if (action === "finalize") return { path: "/carry/positions/finalize", scope: "carry:write" as const, operationClass: "/finalize" };
  return null;
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function workerConfig() {
  const raw = resolvePrivateAgentWorkerUrl({
    connector_url: process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL,
    execution_url: process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL || process.env.PRIVATE_AGENT_EXECUTION_URL,
    worker_url: process.env.GHOLA_PRIVATE_AGENT_WORKER_URL || process.env.PRIVATE_AGENT_WORKER_URL,
    phala_endpoint: process.env.PHALA_AGENT_ENDPOINT,
  });
  let url: URL | null = null;
  try {
    if (raw) url = new URL(raw);
  } catch {
    url = null;
  }
  return {
    url,
    token: process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN?.trim() ||
      process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
      process.env.PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
      process.env.PRIVATE_AGENT_WORKER_TOKEN?.trim() || "",
  };
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
