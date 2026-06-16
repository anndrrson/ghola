import { describe, expect, it } from "vitest";
import {
  levelTriggerSupportsPlan,
  mandateFromPlan,
  type LevelTriggerPlanInput,
} from "./private-account-client";

const basePlan: LevelTriggerPlanInput = {
  side: "buy",
  venueId: "hyperliquid",
  market: "BTC-USD",
  notionalUsd: 5,
  maxSlippageBps: 50,
  strategyProfile: "breakout",
  entryTrigger: "break_level",
  exitRule: "exit_on_invalidation",
  timeHorizon: "until_invalidated",
  triggerLevel: "65000",
  invalidationLevel: "64000",
};

describe("level_trigger plan -> worker mandate mapping", () => {
  it("maps the /trade strategy profile onto the worker vocabulary", () => {
    expect(mandateFromPlan({ ...basePlan, strategyProfile: "breakout" }).strategy_profile).toBe("breakout_retest");
    expect(mandateFromPlan({ ...basePlan, strategyProfile: "trend_following" }).strategy_profile).toBe("momentum_continuation");
    expect(mandateFromPlan({ ...basePlan, strategyProfile: "reversal" }).strategy_profile).toBe("sweep_reclaim");
    expect(mandateFromPlan({ ...basePlan, strategyProfile: "weird" }).strategy_profile).toBe("custom");
  });

  it("passes worker-compatible trigger/levels through and defaults the exit to invalidation", () => {
    const mandate = mandateFromPlan(basePlan);
    expect(mandate.entry_trigger).toBe("break_level");
    expect(mandate.trigger_level).toBe("65000");
    expect(mandate.invalidation_level).toBe("64000");
    expect(mandate.exit_rule).toBe("exit_on_invalidation");
  });

  it("only treats level-based plans with a stop as armable", () => {
    expect(levelTriggerSupportsPlan(basePlan)).toBe(true);
    expect(levelTriggerSupportsPlan({ ...basePlan, invalidationLevel: undefined })).toBe(false);
    expect(levelTriggerSupportsPlan({ ...basePlan, triggerLevel: undefined })).toBe(false);
    expect(levelTriggerSupportsPlan({ ...basePlan, entryTrigger: "book_imbalance" })).toBe(false);
    expect(levelTriggerSupportsPlan({ ...basePlan, entryTrigger: "preview_now", triggerLevel: undefined })).toBe(true);
  });
});
