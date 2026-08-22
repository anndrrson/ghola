import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildPublicPrivateAgentDemoCapabilities,
  buildPublicPrivateAgentDemoRunFromCapabilities,
  getPublicPrivateAgentDemoCapabilities,
  type PublicPrivateAgentWorkerPublicStatus,
} from "./private-account-demo";
import type { PrivateAgentRuntimeStatus } from "./private-agent-runtime";
import type { PooledWorkerReadiness } from "./private-account-pooled-readiness";

const checkedAt = "2026-06-13T12:00:00.000Z";
const rawRecipientKey = "aa".repeat(32);
const rawEndpoint = "https://worker.example";

const runtimeReady: PrivateAgentRuntimeStatus = {
  version: 1,
  checked_at: checkedAt,
  sealed_execution_required: true,
  entitlement_required: "paid_private_agent_plan",
  bounded_beta_enabled: false,
  operator_spend_lock: false,
  preferred_provider: "phala",
  selected_provider: "phala",
  remote_execution_ready: true,
  shielded_rail_ready: true,
  blocking_reasons: [],
  disclosure: "test",
  providers: [
    {
      id: "phala",
      label: "Phala TEE",
      configured: true,
      available: true,
      attested: true,
      supports_sealed_secrets: true,
      supports_background_agents: true,
      supports_trading_execution: true,
      reason: null,
      execution_url: rawEndpoint,
      sealed_recipient: {
        recipient_id: "phala:test",
        x25519_pub_hex: rawRecipientKey,
        tee_kind: "phala",
        measurement_hex: "bb".repeat(32),
        attestation_hash: "quote-test",
        expires_at_unix: null,
      },
      evidence: {
        tee_kind: "phala",
        verifier_url_configured: true,
        execution_url_configured: true,
        image_digest_configured: true,
        recipient_configured: true,
        report_data_bound: true,
        funding_signer_bound: true,
        phala_attestation_present: true,
      },
    },
  ],
};

const pooledReadiness: PooledWorkerReadiness = {
  status: "blocked",
  ready: false,
  endpoint_configured: true,
  checked_at: checkedAt,
  reason_codes: [],
  venues: {
    hyperliquid: {
      venue_id: "hyperliquid",
      status: "blocked",
      ready: false,
      reason_codes: [
        "hyperliquid_pooled_account_pool_missing",
        "hyperliquid:funded_full_ticket_canary_missing",
      ],
    },
    phoenix: {
      venue_id: "phoenix",
      status: "ready",
      ready: true,
      reason_codes: [],
    },
    jupiter: {
      venue_id: "jupiter",
      status: "blocked",
      ready: false,
      reason_codes: ["jupiter_api_key_missing"],
    },
    backpack: {
      venue_id: "backpack",
      status: "blocked",
      ready: false,
      reason_codes: ["backpack_pooled_disabled"],
    },
    coinbase: {
      venue_id: "coinbase",
      status: "blocked",
      ready: false,
      reason_codes: ["coinbase_omnibus_pool_not_ready"],
    },
  },
};

describe("public private-agent demo", () => {
  it("keeps the public proof builder outside the paid worker wake boundary", () => {
    const source = readFileSync("src/lib/private-account-demo.ts", "utf8");
    expect(source).not.toContain("wakePhalaPrivateAgentForUse");
    expect(source).not.toContain("public_no_submit_review");
    expect(source).toContain("Reviewer traffic is deliberately observation-only");
  });

  it("publishes a green no-submit capability proof without exposing worker secrets", async () => {
    const fetchImpl = async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return jsonResponse({
          ok: true,
          ready: true,
          attested_ready: true,
          provider: "phala",
          tee_kind: "phala",
          image_digest: "sha256:worker-image-test",
          report_data_hex: "cc".repeat(32),
          quote_hash: "dd".repeat(32),
        });
      }
      if (url.endsWith("/.well-known/private-agent-recipient")) {
        return jsonResponse({
          recipient_id: "phala:test",
          x25519_pub_hex: rawRecipientKey,
          tee_kind: "phala",
          image_digest: "sha256:worker-image-test",
          report_data_hex: "cc".repeat(32),
          quote_hash: "dd".repeat(32),
          attested_ready: true,
        });
      }
      return new Response("not found", { status: 404 });
    };

    const capabilities = await getPublicPrivateAgentDemoCapabilities({
      env: { GHOLA_PRIVATE_AGENT_EXECUTION_URL: rawEndpoint },
      fetchImpl,
      now: new Date(checkedAt),
      runtimeStatus: runtimeReady,
      pooledReadiness,
    });

    expect(capabilities.status).toBe("green");
    expect(capabilities.demo_mode).toBe("public_no_wallet_no_deposit_no_submit");
    expect(capabilities.worker.recipient_id).toBe("phala:test");
    expect(capabilities.worker.recipient_commitment).toMatch(/^public_demo_worker_recipient_/);
    expect(capabilities.live_submit.status).toBe("gated");
    expect(capabilities.live_submit.ready_venues).toEqual(["phoenix"]);
    expect(capabilities.live_submit.reason_codes).toContain(
      "hyperliquid:hyperliquid_pooled_account_pool_missing",
    );

    const serialized = JSON.stringify(capabilities);
    expect(serialized).not.toContain(rawRecipientKey);
    expect(serialized).not.toContain(rawEndpoint);
    expect(serialized).not.toContain("sha256:worker-image-test");
  });

  it("builds a no-submit ticket and keeps custom strategy text committed only", () => {
    const capabilities = buildCapabilitiesWithWorker({
      endpoint_configured: true,
      endpoint_url_commitment: "public_demo_worker_endpoint_abc",
      reachable: true,
      ready: true,
      attested_ready: true,
      provider: "phala",
      tee_kind: "phala",
      recipient_id: "phala:test",
      recipient_commitment: "public_demo_worker_recipient_abc",
      image_digest_commitment: "public_demo_worker_image_digest_abc",
      report_data_commitment: "public_demo_worker_report_data_abc",
      quote_hash_commitment: "public_demo_worker_quote_hash_abc",
      reason_codes: [],
    });
    const rawIntent = "enter a confidential BTC momentum trade only if liquidity is clean";
    const run = buildPublicPrivateAgentDemoRunFromCapabilities(
      { intent: rawIntent, notional_bucket: 90, max_slippage_bps: 43 },
      capabilities,
      new Date(checkedAt),
    );

    expect(run.status).toBe("verified_no_submit_structural");
    expect(run.execution_mode).toBe("public_no_submit");
    expect(run.wallet_required).toBe(false);
    expect(run.deposit_required).toBe(false);
    expect(run.broadcast).toBe(false);
    expect(run.scenario).toMatchObject({
      scenario_id: "custom_private_intent",
      venue_id: "phoenix",
      market_id: "BTC-USD",
      notional_bucket: "100",
      max_slippage_bps: 43,
    });
    expect(run.execution_ticket.private_intent_commitment).toMatch(/^public_demo_private_intent_/);
    expect(run.execution_ticket.sealed_envelope_commitment).toMatch(/^public_demo_sealed_envelope_/);
    expect(run.venue_gate.ready).toBe(true);

    expect(JSON.stringify(run)).not.toContain(rawIntent);
  });

  it("degrades instead of claiming readiness when the worker proof is missing", () => {
    const capabilities = buildCapabilitiesWithWorker({
      endpoint_configured: false,
      endpoint_url_commitment: null,
      reachable: false,
      ready: false,
      attested_ready: false,
      provider: null,
      tee_kind: null,
      recipient_id: null,
      recipient_commitment: null,
      image_digest_commitment: null,
      report_data_commitment: null,
      quote_hash_commitment: null,
      reason_codes: ["private_agent_worker_endpoint_missing"],
    });

    expect(capabilities.status).toBe("degraded");
    expect(capabilities.capabilities.find((item) => item.id === "no_submit_demo_ready")?.status)
      .toBe("green");

    const run = buildPublicPrivateAgentDemoRunFromCapabilities(
      { scenario_id: "btc_momentum", venue_id: "phoenix" },
      capabilities,
      new Date(checkedAt),
    );

    expect(run.status).toBe("degraded");
    expect(run.execution_mode).toBe("public_no_submit");
    expect(run.wallet_required).toBe(false);
    expect(run.deposit_required).toBe(false);
    expect(run.broadcast).toBe(false);
  });
});

function buildCapabilitiesWithWorker(workerStatus: PublicPrivateAgentWorkerPublicStatus) {
  return buildPublicPrivateAgentDemoCapabilities({
    runtime: runtimeReady,
    pooledReadiness,
    workerStatus,
    checkedAt,
  });
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}
