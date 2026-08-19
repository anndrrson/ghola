import { describe, expect, it, vi } from "vitest";
import { canonicalLiveTradingCaps } from "@/lib/live-trading-contract";
import type { LiveTradingOpeningAccessInspection } from "@/lib/live-trading-opening-access.server";
import {
  createTerminalAccessStatusGet,
  type TerminalAccessStatusDependencies,
} from "./_handler";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

describe("authenticated terminal-access status", () => {
  it("rejects unauthenticated callers before inspecting account state", async () => {
    const inspect = vi.fn();
    const get = createTerminalAccessStatusGet(dependencies({
      ownerFromRequest: vi.fn(async () => null),
      inspectOpeningAccess: inspect,
    }));
    const response = await get(request());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "private_account_auth_required" });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("returns a non-public owner-bound canary status without exposing account commitments", async () => {
    const inspect = vi.fn(async () => inspection());
    const get = createTerminalAccessStatusGet(dependencies({ inspectOpeningAccess: inspect }));
    const response = await get(request("session-token"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      version: 1,
      status: "green",
      opening_orders_enabled: true,
      access_mode: "account_canary",
      launch_state: "canary",
      account_requirements: {
        account_ready: true,
        vault_ready: true,
        eligibility_ready: true,
        entitlement_ready: true,
        graduation_ready: true,
      },
      reason_codes: [],
    });
    expect(body.access_commitment).toMatch(/^live_trading_terminal_access_[a-f0-9]{48}$/u);
    expect(JSON.stringify(body)).not.toContain("account_canary_secret");
    expect(JSON.stringify(body)).not.toContain("vault_canary_secret");
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({
      owner_commitment: "owner_canary_test",
      web_session_token: "session-token",
      required_capabilities: ["limit_order"],
    }));
  });

  it("returns red for the authenticated but ungraduated account", async () => {
    const get = createTerminalAccessStatusGet(dependencies({
      inspectOpeningAccess: vi.fn(async () => inspection({
        ready: false,
        access_mode: null,
        authorized_capabilities: [],
        graduation_ready: false,
        graduation_completed_at: null,
        reason_codes: ["funded_account_proof_required"],
      })),
    }));
    const body = await (await get(request("session-token"))).json();

    expect(body).toMatchObject({
      status: "red",
      opening_orders_enabled: false,
      access_mode: "blocked",
      account_requirements: { graduation_ready: false },
      authorized_capabilities: [],
      reason_codes: ["funded_account_proof_required"],
    });
  });
});

function dependencies(
  overrides: Partial<Record<keyof TerminalAccessStatusDependencies, unknown>> = {},
): TerminalAccessStatusDependencies {
  return {
    ownerFromRequest: vi.fn(async () => ({
      user: { id: "user_canary_test", email: "investor@example.com" },
      owner_commitment: "owner_canary_test",
    })),
    sessionTokenFromRequest: vi.fn((request: Request) => request.headers.get("authorization")?.slice(7) ?? null),
    inspectOpeningAccess: vi.fn(async () => inspection()),
    ...overrides,
  } as unknown as TerminalAccessStatusDependencies;
}

function request(token?: string) {
  return new Request("https://ghola.test/v1/private-account/live-trading/terminal-access", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function inspection(
  overrides: Partial<LiveTradingOpeningAccessInspection> = {},
): LiveTradingOpeningAccessInspection {
  return {
    ready: true,
    access_mode: "account_canary",
    launch_state: "canary",
    launch_revision: 1,
    release_identity: {
      contract_version: 2,
      web_git_sha: SHA,
      worker_git_sha: SHA,
      worker_image_digest: DIGEST,
      config_fingerprint: "live_trading_config_canary_test",
      valid: true,
      reason_codes: [],
    },
    live_worker_readiness: {
      ready: true,
      endpoint_configured: true,
      contract_version: 2,
      worker_git_sha: SHA,
      worker_image_digest: DIGEST,
      config_fingerprint: "live_trading_config_canary_test",
      capabilities: ["limit_order"],
      reason_codes: [],
      checked_at: new Date().toISOString(),
    },
    effective_caps: canonicalLiveTradingCaps(),
    configured_capabilities: ["limit_order"],
    required_capabilities: ["limit_order"],
    authorized_capabilities: ["limit_order"],
    account_ready: true,
    vault_ready: true,
    eligibility_ready: true,
    entitlement_ready: true,
    graduation_ready: true,
    graduation_completed_at: new Date().toISOString(),
    reason_codes: [],
    denial: null,
    account_commitment: "account_canary_secret",
    vault_commitment: "vault_canary_secret",
    ...overrides,
  };
}
