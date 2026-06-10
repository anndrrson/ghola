import { afterEach, describe, expect, it } from "vitest";
import { POST as postArbCanaryReport } from "@/app/v1/private-account/agent-passport/arb-canary-report/route";
import { POST as armArbRoute } from "@/app/v1/private-account/agent-passport/arm-arb/route";
import {
  privateAccountOwnerFromRequest,
  type PrivateAccountRequestOwner,
} from "@/app/v1/private-account/_lib";
import {
  agentPassportReadinessForOwner,
  linkAgentPlatformFromBody,
} from "./private-agent-passport";
import { resetPrivateAccountStoreForTests } from "./private-account-store";

const owner: PrivateAccountRequestOwner = {
  owner_commitment: "owner_passport_test",
  user: {
    id: "passport_user",
    email: "passport@example.com",
  },
};

describe("agent passport venue linking", () => {
  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    delete process.env.PRIVATE_AGENT_ARB_LIVE_SUBMIT;
    delete process.env.PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD;
    delete process.env.PRIVATE_AGENT_ARB_DAILY_NOTIONAL_CAP_USD;
    delete process.env.PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS;
    delete process.env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE;
    delete process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL;
    delete process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN;
    delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN;
    delete process.env.GHOLA_ARB_CANARY_MAX_STALE_MS;
  });

  it("records sealed trade-only venue capabilities and blocks withdrawal scopes", async () => {
    const linked = await linkAgentPlatformFromBody({
      venue_id: "coinbase_advanced",
      permission_attestation: {
        scopes: ["view", "trade"],
      },
      encrypted_execution_vault: sealedVault("coinbase"),
    }, owner, new Date("2026-06-03T12:00:00.000Z"));

    expect("error" in linked).toBe(false);
    if ("error" in linked) return;
    expect(linked.capability.venue_id).toBe("coinbase_advanced");
    expect(linked.capability.can_read).toBe(true);
    expect(linked.capability.can_trade).toBe(true);
    expect(linked.capability.can_withdraw).toBe(false);
    expect(linked.capability.vault_commitment).toMatch(/^venue_execution_vault_/);

    const blocked = await linkAgentPlatformFromBody({
      venue_id: "hyperliquid",
      permission_attestation: {
        scopes: ["read", "trade", "withdraw"],
      },
      encrypted_execution_vault: sealedVault("hyperliquid"),
    }, owner);

    expect(blocked).toEqual({ error: "withdraw_permission_blocked" });
  });

  it("requires Hyperliquid plus a spot or swap venue for guarded arbitrage readiness", async () => {
    await linkAgentPlatformFromBody({
      venue_id: "hyperliquid",
      permission_attestation: { scopes: ["read", "trade"] },
      encrypted_execution_vault: sealedVault("hyperliquid"),
    }, owner);
    let readiness = await agentPassportReadinessForOwner(owner);
    expect(readiness.can_arm).toBe(false);
    expect(readiness.blockers).toContain("second_spot_or_swap_venue_required");

    await linkAgentPlatformFromBody({
      venue_id: "jupiter",
      execution_mode: "user_stealth",
      permission_attestation: { scopes: ["read", "trade"] },
      encrypted_execution_vault: sealedVault("jupiter"),
    }, owner);
    process.env.PRIVATE_AGENT_ARB_LIVE_SUBMIT = "true";
    process.env.PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD = "25";
    process.env.PRIVATE_AGENT_ARB_DAILY_NOTIONAL_CAP_USD = "100";
    process.env.PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS = "25";
    process.env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS = "2000";

    readiness = await agentPassportReadinessForOwner(owner);
    expect(readiness.can_arm).toBe(true);
    expect(readiness.can_live_submit).toBe(true);
    expect(readiness.ready_venues).toEqual(expect.arrayContaining(["hyperliquid", "jupiter"]));
  });

  it("rejects arm-arb until Agent Passport has a hedged venue pair", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "report_only";
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";

    const res = await armArbRoute(authedPost("/v1/private-account/agent-passport/arm-arb", {
      mode: "no_submit",
      market: "SOL-USD",
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("agent_passport_not_ready");
    expect(body.blockers).toContain("hyperliquid_required");
  });

  it("stores arb canary diagnostics without making Agent Passport readiness depend on them", async () => {
    let readiness = await agentPassportReadinessForOwner(owner, new Date("2026-06-03T12:00:00.000Z"));
    expect(readiness.can_arm).toBe(false);
    expect(readiness.arb_canary_required).toBe(false);
    expect(readiness.arb_canary_status).toBe("missing");
    expect(readiness.blockers).toContain("hyperliquid_required");
    expect(readiness.blockers).not.toContain("agent_arb_canary_missing");

    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = "internal_agent_arb_canary_token_32_bytes";
    const reportRes = await postArbCanaryReport(internalPost("/v1/private-account/agent-passport/arb-canary-report", {
      canary_id: "arb_canary_green_123",
      status: "no_submit_pair_verified",
      mode: "no_submit",
      market: "SOL-USD",
      worker_url: "https://worker.example/private/path",
      completed_at: "2026-06-03T12:01:00.000Z",
      leg_notional_usd: 5,
      checks: [
        { name: "coinbase no-submit preflight", ok: true, result_commitment: "result_coinbase" },
        { name: "hyperliquid no-submit preflight", ok: true, result_commitment: "result_hyperliquid" },
      ],
      preflight: {
        coinbase: { verification_commitment: "verify_coinbase" },
        hyperliquid: { verification_commitment: "verify_hyperliquid" },
      },
    }));
    const reportBody = await reportRes.json();
    expect(reportRes.status, JSON.stringify(reportBody)).toBe(202);
    expect(reportBody.report.status).toBe("green");

    readiness = await agentPassportReadinessForOwner(owner, new Date("2026-06-03T12:02:00.000Z"));
    expect(readiness.can_arm).toBe(false);
    expect(readiness.arb_canary_required).toBe(false);
    expect(readiness.arb_canary_status).toBe("green");
    expect(readiness.arb_canary_report).not.toBeNull();
    if (!readiness.arb_canary_report) throw new Error("expected arb canary report");
    expect(readiness.arb_canary_report.worker_url).toBe("https://worker.example");
    expect(readiness.blockers).toContain("hyperliquid_required");
    expect(readiness.blockers).not.toContain("agent_arb_canary_missing");
  });

  it("rejects arb canary reports that include secret-looking fields", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = "internal_agent_arb_canary_token_32_bytes";
    const res = await postArbCanaryReport(internalPost("/v1/private-account/agent-passport/arb-canary-report", {
      canary_id: "arb_canary_secret_123",
      status: "failed",
      mode: "no_submit",
      market: "SOL-USD",
      completed_at: "2026-06-03T12:01:00.000Z",
      checks: [{ name: "fatal", ok: false, error: "failed" }],
      api_private_key_pem: "-----BEGIN PRIVATE KEY-----",
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_agent_arb_canary_report");
    expect(body.reason_codes).toContain("secret_field_rejected");
  });

  it("fails arm-arb instead of returning a pending session when the worker is unavailable", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "report_only";
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";

    const routeOwner = await privateAccountOwnerFromRequest(authedPost("/v1/private-account/agent-passport/arm-arb", {}));
    expect(routeOwner).not.toBeNull();
    if (!routeOwner) return;
    const linkedHyperliquid = await linkAgentPlatformFromBody({
      venue_id: "hyperliquid",
      permission_attestation: { scopes: ["read", "trade"] },
      encrypted_execution_vault: sealedVault("hyperliquid"),
    }, routeOwner);
    const linkedCoinbase = await linkAgentPlatformFromBody({
      venue_id: "coinbase_advanced",
      permission_attestation: { scopes: ["read", "trade"] },
      encrypted_execution_vault: sealedVault("coinbase"),
    }, routeOwner);
    expect("error" in linkedHyperliquid).toBe(false);
    expect("error" in linkedCoinbase).toBe(false);

    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "token";

    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://worker.example/autopilot/sessions") {
        return new Response(JSON.stringify({ error: "worker_booting" }), { status: 503 });
      }
      return oldFetch(input);
    }) as typeof fetch;

    try {
      const res = await armArbRoute(authedPost("/v1/private-account/agent-passport/arm-arb", {
        mode: "no_submit",
        market: "SOL-USD",
      }));
      const body = await res.json();

      expect(res.status, JSON.stringify(body)).toBe(502);
      expect(body.error).toBe("worker_arb_not_armed");
      expect(body.session.status).toBe("pending_worker");
      expect(body.session.worker_autopilot_session_id).toBeNull();
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("arms a guarded arbitrage worker session from Agent Passport venues", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "report_only";
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
    process.env.PRIVATE_AGENT_ARB_LIVE_SUBMIT = "true";
    process.env.PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD = "5";
    process.env.PRIVATE_AGENT_ARB_DAILY_NOTIONAL_CAP_USD = "25";
    process.env.PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS = "25";
    process.env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS = "2000";

    const routeOwner = await privateAccountOwnerFromRequest(authedPost("/v1/private-account/agent-passport/arm-arb", {}));
    expect(routeOwner).not.toBeNull();
    if (!routeOwner) return;
    const linkedHyperliquid = await linkAgentPlatformFromBody({
      venue_id: "hyperliquid",
      permission_attestation: { scopes: ["read", "trade"] },
      encrypted_execution_vault: sealedVault("hyperliquid"),
    }, routeOwner);
    const linkedCoinbase = await linkAgentPlatformFromBody({
      venue_id: "coinbase_advanced",
      permission_attestation: { scopes: ["read", "trade"] },
      encrypted_execution_vault: sealedVault("coinbase"),
    }, routeOwner);
    expect("error" in linkedHyperliquid).toBe(false);
    expect("error" in linkedCoinbase).toBe(false);

    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "token";

    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://worker.example/autopilot/sessions") {
        return new Response(JSON.stringify({
          version: 1,
          session: {
            version: 2,
            autopilot_session_id: "worker_arb_123",
            worker_session_commitment: "worker_arb_commitment_123",
            status: "running",
            strategy: {
              version: 1,
              strategy_id: "hedged_spread_arbitrage_v1",
              decision_model: "rules_plus_ai_score",
              executable_order_source: "deterministic_guarded_arb_planner",
              ai_can_execute_directly: false,
            },
            session_policy: {
              strategy_id: "hedged_spread_arbitrage_v1",
              venue_allowlist: ["coinbase_advanced", "hyperliquid"],
              market_allowlist: ["SOL-USD"],
              max_notional_bucket: "5",
              max_daily_notional_bucket: "25",
              max_order_count: 4,
              ttl_ms: 60 * 60_000,
              max_slippage_bps: 25,
              cooldown_ms: 60_000,
              data_max_age_ms: 15_000,
              min_net_edge_bps: 25,
              max_execution_skew_ms: 2000,
              kill_switch: false,
              policy_commitment: "worker_arb_policy",
            },
            venue_access: {
              coinbase_advanced: { status: "ready", execution_mode: "byo_api_key", reason: "agent_passport_ready" },
              hyperliquid: { status: "ready", execution_mode: "byo_api_key", reason: "agent_passport_ready" },
            },
            order_count: 0,
            daily_notional_used_bucket: "0",
            updated_at: "2026-06-03T12:00:00.000Z",
            expires_at: "2026-06-03T13:00:00.000Z",
            next_step: "Autonomous worker is running.",
            execution_enabled: true,
          },
          events: [],
        }), { status: 201 });
      }
      return oldFetch(input);
    }) as typeof fetch;

    try {
      const res = await armArbRoute(authedPost("/v1/private-account/agent-passport/arm-arb", {
        mode: "tiny_live",
        market: "SOL-USD",
      }));
      const body = await res.json();

      expect(res.status, JSON.stringify(body)).toBe(201);
      expect(body.session.status).toBe("running");
      expect(body.session.worker_autopilot_session_id).toBe("worker_arb_123");
      expect(body.session.session_policy.strategy_id).toBe("hedged_spread_arbitrage_v1");
      expect(body.readiness.can_live_submit).toBe(true);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});

function sealedVault(label: string) {
  return {
    alg: "sealed-provider-v1",
    ciphertext: `sealed-${label}-vault`,
    recipient: "phala:cvm:test",
    aad: `ghola/${label}-execution-vault-v1|account:acct|recipient:phala:cvm:test`,
  };
}

function authedPost(path: string, body: unknown) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer investor-test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function internalPost(path: string, body: unknown) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer internal_agent_arb_canary_token_32_bytes",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
