import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutopilotSession, runAutopilotTick } from "../src/execution/autopilot.js";
import { createWorkerState } from "../src/state/private-state.js";

const OLD_ENV = { ...process.env };

describe("autopilot agent mandate", () => {
  let dir;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    dir = mkdtempSync(join(tmpdir(), "ghola-mandate-"));
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
    process.env.PRIVATE_AGENT_AUTOPILOT_SIGNAL_MODE = "force";
    process.env.PRIVATE_AGENT_AUTOPILOT_FORCE_PRICE = "100";
    // Positive forced change → momentum default would pick "buy".
    process.env.PRIVATE_AGENT_AUTOPILOT_FORCE_CHANGE_PCT = "1";
    process.env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT = "true";
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function tickWithMandate(mandate) {
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-mandate-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_mandate_test",
        session_policy: {
          ai_direct_enabled: false,
          venue_allowlist: ["jupiter"],
          market_allowlist: ["SOL-USD"],
          max_notional_bucket: "50",
          max_daily_notional_bucket: "250",
          max_order_count: 10,
          ttl_ms: 2 * 60 * 60_000,
          max_slippage_bps: 50,
          ...(mandate ? { agent_mandate: mandate } : {}),
        },
      },
      recipient,
      state,
      provider: "test",
      startLoop: false,
      now,
    });
    const tick = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });
    return { session, tick };
  }

  it("follows the momentum side when no mandate is present", async () => {
    const { session, tick } = await tickWithMandate(null);
    assert.equal(tick.ok, true);
    assert.equal(tick.proposal.side, "buy");
    assert.equal(session.session_policy.agent_mandate, undefined);
  });

  it("forces the proposal to the user's buy/sell mandate, overriding the signal", async () => {
    const { session, tick } = await tickWithMandate({
      version: 1,
      side: "sell",
      strategy_profile: "mean_reversion",
      entry_trigger: "preview_now",
      exit_rule: "manual_approval",
      time_horizon: "scalp",
    });
    assert.equal(tick.ok, true);
    // Momentum signal is positive ("buy"); the mandate must override it.
    assert.equal(tick.proposal.side, "sell");
    assert.equal(session.session_policy.agent_mandate.side, "sell");
    assert.equal(session.session_policy.agent_mandate.strategy_profile, "mean_reversion");
  });

  it("leaves the agent free to choose on an 'auto' mandate", async () => {
    const { tick } = await tickWithMandate({
      version: 1,
      side: "auto",
      strategy_profile: "momentum_continuation",
    });
    assert.equal(tick.ok, true);
    assert.equal(tick.proposal.side, "buy");
  });
});
