import { gholaCommitment } from "@/lib/private-account";
import {
  inspectLiveTradingOpeningAccess,
  terminalLiveTradingOpeningCapabilities,
} from "@/lib/live-trading-opening-access.server";
import {
  json,
  privateAccountOwnerFromRequest,
  privateAccountSessionTokenFromRequest,
  unauthorized,
} from "../../_lib";

export interface TerminalAccessStatusDependencies {
  ownerFromRequest: typeof privateAccountOwnerFromRequest;
  sessionTokenFromRequest: typeof privateAccountSessionTokenFromRequest;
  inspectOpeningAccess: typeof inspectLiveTradingOpeningAccess;
}

export function createTerminalAccessStatusGet(
  dependencies: TerminalAccessStatusDependencies,
) {
  return (request: Request) => handleGet(request, dependencies);
}

async function handleGet(request: Request, dependencies: TerminalAccessStatusDependencies) {
  const owner = await dependencies.ownerFromRequest(request);
  const sessionToken = dependencies.sessionTokenFromRequest(request);
  if (!owner || !sessionToken) return unauthorized();

  const inspection = await dependencies.inspectOpeningAccess({
    owner_commitment: owner.owner_commitment,
    web_session_token: sessionToken,
    required_capabilities: terminalLiveTradingOpeningCapabilities(process.env),
    env: process.env,
    fetchImpl: globalThis.fetch,
  });
  const checkedAt = new Date().toISOString();
  const response = {
    version: 1 as const,
    status: inspection.ready ? "green" as const : "red" as const,
    venue_id: "hyperliquid" as const,
    network: "mainnet" as const,
    opening_orders_enabled: inspection.ready,
    access_mode: inspection.access_mode ?? "blocked" as const,
    launch_state: inspection.launch_state,
    release_identity: inspection.release_identity,
    live_worker_readiness: inspection.live_worker_readiness,
    effective_caps: inspection.effective_caps,
    configured_capabilities: inspection.configured_capabilities,
    required_capabilities: inspection.required_capabilities,
    authorized_capabilities: inspection.authorized_capabilities,
    account_requirements: {
      account_ready: inspection.account_ready,
      vault_ready: inspection.vault_ready,
      eligibility_ready: inspection.eligibility_ready,
      entitlement_ready: inspection.entitlement_ready,
      graduation_ready: inspection.graduation_ready,
    },
    graduation_completed_at: inspection.graduation_completed_at,
    reason_codes: inspection.reason_codes,
    checked_at: checkedAt,
  };
  return json({
    ...response,
    access_commitment: gholaCommitment("live_trading_terminal_access", response),
  });
}
