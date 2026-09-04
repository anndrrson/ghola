import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  carryCreationProofFreshness,
  carryCollateralBasisSummary,
  CarryTerminalBuilder,
  carryCapitalEfficiencySummary,
  carryCheckFailure,
  carryFundingPersistenceSummary,
  carryLiquidationSummary,
  carryMatrixPairReady,
  carryOpeningCapitalSummary,
  carryPortfolioRunwaySummary,
  carryPortfolioValueSummary,
  carryRiskMandateSummary,
  carrySupervisionSummary,
  carryTerminalEconomics,
  carryTerminalGrossFunding,
  carryVenueMinimumMarginSummary,
} from "./CarryTerminalBuilder";
import { builderModel, type CarryCandidate } from "@/lib/carry-market";
import { carryPrivatePrimeEvidenceCommitment } from "@/lib/carry-private-prime-readiness";
import { defaultCarryRiskMandate } from "@/lib/carry-risk-mandate";

const OPPORTUNITY_EVIDENCE = `carry:creation-opportunity:evidence:${"a".repeat(64)}`;

const api = vi.hoisted(() => ({
  createCarryPosition: vi.fn(),
  approveCarryCollateralReview: vi.fn(),
  executeCarryPositionEntry: vi.fn(),
  getCarryCollateralReview: vi.fn(),
  getCarryExecutionReadiness: vi.fn(),
  getCarryPortfolioCapitalPlan: vi.fn(),
  getCarryPortfolioValueReport: vi.fn(),
  getPrivateAgentPassport: vi.fn(),
  listCarryPositions: vi.fn(),
  preflightCarryExecutionMatrix: vi.fn(),
  preflightCarryPair: vi.fn(),
  requestCarryPositionExit: vi.fn(),
}));
const perps = vi.hoisted(() => ({
  authenticated: true,
  ensureWalletPair: vi.fn(),
  signCarryRiskMandate: vi.fn(),
  signCarryCollateralReview: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  authenticated: true,
  loading: false,
}));

vi.mock("@/lib/private-account-client", () => api);
vi.mock("@/lib/perps-turnkey-provider", () => ({
  usePerpsTurnkey: () => ({
    authenticated: perps.authenticated,
    ensureWalletPair: perps.ensureWalletPair,
    signCarryRiskMandate: perps.signCarryRiskMandate,
    signCarryCollateralReview: perps.signCarryCollateralReview,
  }),
}));
vi.mock("@/lib/thumper-auth-context", () => ({
  useThumperAuth: () => auth,
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props}>{children}</a> }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CarryTerminalBuilder", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    auth.authenticated = true;
    auth.loading = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    api.createCarryPosition.mockReset();
    api.approveCarryCollateralReview.mockReset();
    api.executeCarryPositionEntry.mockReset();
    api.getCarryCollateralReview.mockReset();
    api.getCarryExecutionReadiness.mockReset();
    api.getCarryPortfolioCapitalPlan.mockReset();
    api.getCarryPortfolioValueReport.mockReset();
    api.getPrivateAgentPassport.mockReset();
    api.listCarryPositions.mockReset();
    api.preflightCarryExecutionMatrix.mockReset();
    api.preflightCarryPair.mockReset();
    api.requestCarryPositionExit.mockReset();
    perps.ensureWalletPair.mockReset();
    perps.signCarryRiskMandate.mockReset();
    perps.signCarryCollateralReview.mockReset();
    perps.authenticated = true;
    api.getPrivateAgentPassport.mockResolvedValue({ owner_commitment: "owner:carry:web:test:0001" });
    api.getCarryExecutionReadiness.mockResolvedValue({
      ready: false,
      reasons: ["carry_readiness_evidence_missing"],
      carry_supervision: healthySupervision(),
    });
    api.getCarryPortfolioCapitalPlan.mockResolvedValue({
      ok: true,
      plan: {
        version: 1,
        kind: "ghola_carry_portfolio_capital_plan",
        status: "balanced",
        position_count: 0,
        total_requested_micro_usdc: 0,
        total_potential_releasable_micro_usdc: 0,
        total_proposed_internal_reallocation_micro_usdc: 0,
        net_new_owner_capital_requested_micro_usdc: 0,
        total_proposed_allocation_micro_usdc: 0,
        total_uncovered_shortfall_micro_usdc: 0,
        proposal_only: true,
        transaction_broadcast: false,
        automatic_transfer_permitted: false,
        owner_only_operations: ["fund", "transfer", "withdraw"],
      },
    });
    api.getCarryCollateralReview.mockResolvedValue({
      ok: true,
      review: {
        version: 1,
        kind: "ghola_carry_collateral_review",
        status: "no_action",
        owner_signature_required: false,
        transfer_instructions: [],
        funding_instructions: [],
        proposal_only: true,
        review_only: true,
        execution_authorized: false,
        fund_movement_authorized: false,
        transaction_broadcast: false,
        automatic_transfer_permitted: false,
        withdrawal_permitted: false,
        trade_permitted: false,
      },
    });
    api.getCarryPortfolioValueReport.mockResolvedValue({
      ok: true,
      report: {
        version: 1,
        kind: "ghola_carry_portfolio_value_report",
        value_proof_status: "empty",
        position_count: 0,
        open_position_count: 0,
        finalized_position_count: 0,
        modeled: { net_value_micro_usdc: 0 },
        finalized_after_costs: { net_value_micro_usdc: 0, variance_from_modeled_micro_usdc: 0 },
        unfinalized: { modeled_net_value_micro_usdc: 0 },
        proposal_only: true,
        transaction_broadcast: false,
        automatic_transfer_permitted: false,
        owner_only_operations: ["fund", "transfer", "withdraw"],
      },
    });
    api.preflightCarryExecutionMatrix.mockResolvedValue(readyMatrix());
    perps.ensureWalletPair.mockResolvedValue({ owner: { address: `0x${"11".repeat(20)}` } });
    perps.signCarryRiskMandate.mockResolvedValue(`0x${"22".repeat(65)}`);
    perps.signCarryCollateralReview.mockResolvedValue(`0x${"22".repeat(65)}`);
    api.approveCarryCollateralReview.mockResolvedValue({ ok: true });
  });

  it("labels worker authorization drift without blaming venue wallets", () => {
    expect(carryCheckFailure(
      new Error("carry_worker_authorization_misconfigured"),
      "ghola-auth-test",
    )).toMatchObject({
      label: "AUTH MISMATCH",
      reference: "AUTH-TEST",
    });
  });

  it("uses full-fleet remediation only after the selected pair is already proven", () => {
    const matrix = {
      pairs: [
        { long_venue_id: "lighter", short_venue_id: "hyperliquid", no_submit_ready: true, transaction_broadcast: false },
        { long_venue_id: "hyperliquid", short_venue_id: "aster", no_submit_ready: false, transaction_broadcast: false },
      ],
    };
    expect(carryMatrixPairReady(matrix, "hyperliquid", "lighter")).toBe(true);
    expect(carryMatrixPairReady(matrix, "hyperliquid", "aster")).toBe(false);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("uses quote inputs owned by the route ranker", async () => {
    const onNotionalChange = vi.fn();
    const onHorizonChange = vi.fn();
    await act(async () => root.render(
      <CarryTerminalBuilder
        candidate={candidate()}
        quoteNotional="250"
        quoteHorizonDays="7"
        onQuoteNotionalChange={onNotionalChange}
        onQuoteHorizonDaysChange={onHorizonChange}
      />,
    ));

    const notional = container.querySelector<HTMLInputElement>('[aria-label="Carry notional per leg"]');
    const horizon = container.querySelector<HTMLInputElement>('[aria-label="Carry horizon in days"]');
    expect(notional?.value).toBe("250");
    expect(horizon?.value).toBe("7");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(notional, "500");
      notional?.dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(horizon, "14");
      horizon?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onNotionalChange).toHaveBeenCalledWith("500");
    expect(onHorizonChange).toHaveBeenCalledWith("14");
  });

  it("keeps a negative horizon net visibly negative", () => {
    const noEdgeCandidate = {
      ...candidate(),
      short: snapshot("lighter", 10_000_001),
      grossAnnualBps: 0.0000876,
    };
    expect(carryTerminalEconomics(builderModel(noEdgeCandidate, "11", "30"), null)).toMatchObject({
      net: expect.stringMatching(/^−\$/),
      netTone: "bad",
    });
  });

  it("never replaces incomplete worker proof with browser estimates", () => {
    const model = builderModel(candidate(), "11", "30");
    const publicEconomics = carryTerminalEconomics(model, null);
    expect(publicEconomics.fees).not.toBe("UNVERIFIED");
    expect(carryOpeningCapitalSummary(model, null).value).toBe("$22 TOTAL · 1×");
    expect(carryTerminalGrossFunding(candidate(), null).value).not.toBe("UNVERIFIED");
    expect(carryVenueMinimumMarginSummary(model, null).value).not.toBe("UNVERIFIED");

    const workerEconomics = carryTerminalEconomics(model, {
      depth_impact: ["hyperliquid", "lighter"].map((venue_id) => ({
        venue_id,
        observations: ["entry", "exit"].map((phase) => ({
          phase,
          status: "sufficient",
          displayed_notional_micro_usdc: 11_000_000,
        })),
      })),
    });
    expect(workerEconomics.fees).toBe("UNVERIFIED");
    expect(workerEconomics.slippage).toBe("UNVERIFIED");
    expect(workerEconomics.net).toBe("UNVERIFIED");
    expect(workerEconomics.breakEven).toBe("UNVERIFIED");
    expect(carryOpeningCapitalSummary(model, {}).value).toBe("UNVERIFIED");
    expect(carryTerminalGrossFunding(candidate(), {}).value).toBe("UNVERIFIED");
    expect(carryVenueMinimumMarginSummary(model, {}).value).toBe("UNVERIFIED");
    expect(carryTerminalGrossFunding(candidate(), {
      projected_gross_funding_micro_usdc: 22_000,
      notional_micro_usdc: 11_000_000,
      horizon_ms: 10 * 86_400_000,
    }).value).toBe("+2.00 BP/D");
    expect(carryVenueMinimumMarginSummary(model, {
      account_readiness: [
        { venue_minimum_margin_micro_usdc: 2_000_000 },
        { venue_minimum_margin_micro_usdc: 3_000_000 },
      ],
    }).value).toBe("$5");
  });

  it("expires actionable creation proof on the same boundary as the worker", () => {
    expect(carryCreationProofFreshness({ checked_at_ms: 10_000 }, 70_000)).toEqual({
      fresh: true,
      expires_at_ms: 70_000,
    });
    expect(carryCreationProofFreshness({ checked_at_ms: 10_000 }, 70_001)).toEqual({
      fresh: false,
      expires_at_ms: 70_000,
    });
    expect(carryCreationProofFreshness({ checked_at_ms: 20_001 }, 15_000)).toEqual({
      fresh: false,
      expires_at_ms: null,
    });
  });

  it("shows collateral assets and only worker-priced cross-collateral stress", () => {
    expect(carryCollateralBasisSummary(candidate(), null)).toEqual({
      value: "USDC/USDC · SAME",
      tone: "good",
    });
    expect(carryCollateralBasisSummary(candidate(), {
      long_collateral_asset: "USDC",
      short_collateral_asset: "USDT",
      collateral_basis_risk_micro_usdc: 500_000,
    })).toEqual({
      value: "USDC/USDT · $0.5 STRESS",
      tone: "warn",
    });
    expect(carryCollateralBasisSummary(candidate(), {
      long_collateral_asset: "USDC",
      short_collateral_asset: "USDT",
      collateral_basis_risk_micro_usdc: 0,
    })).toEqual({ value: "UNVERIFIED", tone: "bad" });
  });

  it("shows only commitment-backed persistent funding as durable", () => {
    expect(carryFundingPersistenceSummary({
      funding_persistence: readyFundingPersistence(),
    })).toEqual({ value: "8/8 · 35M · DURABLE", tone: "good", ready: true });
    expect(carryFundingPersistenceSummary({
      funding_persistence: {
        version: 1,
        ready: false,
        reasons: ["funding_history_insufficient", "funding_observation_span_insufficient"],
        sample_count: 2,
        minimum_samples: 8,
        observed_span_ms: 300_000,
        minimum_span_ms: 1_800_000,
        conservative_hourly_spread_e12: 100_000_000,
      },
    })).toEqual({ value: "2/8 · 5M OBSERVED", tone: "warn", ready: false });
  });

  it("shows compact private-prime readiness without claiming a live lifecycle", async () => {
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [] });
    api.getCarryExecutionReadiness.mockResolvedValue({
      ...readyReadiness(),
      private_prime_readiness: privatePrimeReadiness(),
      carry_supervision: healthySupervision(),
    });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    expect(container.textContent).toContain("PRIVATE PRIME");
    expect(container.textContent).toContain("5/5 DATA · 3/3 EXEC · 3/3 REC · 6/6 ROUTES");
    expect(container.textContent).toContain("QUALIFIED · NO-SUBMIT ONLY · LIVE PAIRED PROOF REQUIRED");
    expect(container.textContent).not.toContain("LIVE PAIRED LIFECYCLE PROVEN");
  });

  it("keeps checking and arming no-submit until a separate live-entry click", async () => {
    const record = carryRecord();
    api.listCarryPositions
      .mockResolvedValueOnce({ ok: true, records: [] })
      .mockResolvedValue({ ok: true, records: [record] });
    const selectedPairResult = {
      correlation_id: "ghola-pair-test-1234",
      no_submit_ready: true,
      live_creation_ready: false,
      qualification_pilot_ready: true,
      qualification_pilot_candidate_venue_id: "lighter",
      creation_opportunity: {
        checked_at_ms: Date.now(),
        eligible: true,
        contract_data_skew_ms: 400,
        max_contract_data_skew_ms: 2_000,
        index_price_divergence_bps: 3,
        mark_price_divergence_bps: 7,
        max_index_price_divergence_bps: 25,
        max_mark_price_divergence_bps: 50,
        funding_persistence: readyFundingPersistence(),
        worker_authentication: { evidence_commitment: OPPORTUNITY_EVIDENCE },
      },
    };
    api.preflightCarryExecutionMatrix.mockResolvedValue({
      ...readyMatrix(),
      selected_pair: {
        long_venue_id: "hyperliquid",
        short_venue_id: "lighter",
        transaction_broadcast: false,
        error_code: null,
        result: selectedPairResult,
      },
    });
    api.createCarryPosition.mockResolvedValue({ ok: true, record });
    api.executeCarryPositionEntry.mockResolvedValue({ ok: true });

    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    expect(container.textContent).toContain("$22 TOTAL · 1×");
    expect(container.textContent).toMatch(/SOURCE SYNC\d+MS · EST/);
    expect(container.textContent).toContain("INDEX BASIS0BP · EST");
    await click("NO-SUBMIT CHECK");
    expect(api.preflightCarryExecutionMatrix).toHaveBeenCalledWith(expect.objectContaining({
      selected_long_venue_id: "hyperliquid",
      selected_short_venue_id: "lighter",
    }));
    expect(api.preflightCarryPair).not.toHaveBeenCalled();
    expect(container.textContent).toContain("NO-SUBMIT RECEIPT");
    expect(container.textContent).toContain("PAIR PAIR-TEST-12");
    expect(container.textContent).toContain("FLEET MATRIX-TEST-");
    expect(container.textContent).toContain("SOURCE SYNC");
    expect(container.textContent).toContain("400MS");
    expect(container.textContent).toContain("INDEX BASIS");
    expect(container.textContent).toContain("3BP");
    expect(container.textContent).toContain("EDGE CONF");
    expect(container.textContent).toContain("8/8 · 35M · DURABLE");
    expect(api.createCarryPosition).not.toHaveBeenCalled();
    expect(api.executeCarryPositionEntry).not.toHaveBeenCalled();

    await click("ARM CAPPED PROOF");
    expect(api.createCarryPosition).toHaveBeenCalledWith(expect.objectContaining({
      qualification_pilot: { enabled: true, candidate_venue_id: "lighter" },
    }));
    expect(api.createCarryPosition).toHaveBeenCalledWith(expect.objectContaining({
      position_input: expect.objectContaining({
        opportunity_evidence_commitment: OPPORTUNITY_EVIDENCE,
        risk_mandate: expect.objectContaining({
          max_contract_data_skew_ms: 2_000,
          max_index_price_divergence_bps: 25,
          max_mark_price_divergence_bps: 50,
          min_migration_improvement_bps: 5,
          migration_venue_allowlist: ["hyperliquid", "lighter", "aster"],
          allow_migration: true,
        }),
        mandate_authorization: expect.objectContaining({ mandate_commitment: expect.stringMatching(/^0x[0-9a-f]{64}$/) }),
      }),
    }));
    expect(api.executeCarryPositionEntry).not.toHaveBeenCalled();

    await click("CONFIRM LIVE PAIRED ENTRY");
    expect(api.executeCarryPositionEntry).toHaveBeenCalledWith("carry:position:test", true);
  });

  it("removes an expired creation action instead of failing after owner signing", async () => {
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [] });
    api.preflightCarryPair.mockResolvedValue({
      no_submit_ready: true,
      live_creation_ready: true,
      qualification_pilot_ready: false,
      creation_opportunity: {
        checked_at_ms: Date.now() - 60_001,
        eligible: true,
        reasons: [],
        funding_persistence: readyFundingPersistence(),
      },
    });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    await click("NO-SUBMIT CHECK");
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("CHECK EXPIRED · rerun the no-submit check before signing");
    expect(container.textContent).not.toContain("SAVE POSITION");
    expect(perps.signCarryRiskMandate).not.toHaveBeenCalled();
  });

  it("does not spend owner authentication on an unbound creation opportunity", async () => {
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [] });
    api.preflightCarryPair.mockResolvedValue({
      no_submit_ready: true,
      live_creation_ready: true,
      qualification_pilot_ready: false,
      creation_opportunity: {
        checked_at_ms: Date.now(),
        eligible: true,
        reasons: [],
        funding_persistence: readyFundingPersistence(),
      },
    });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    await click("NO-SUBMIT CHECK");
    await click("SAVE POSITION");
    expect(container.textContent).toContain("CHECK INVALID · rerun the no-submit check before signing");
    expect(perps.ensureWalletPair).not.toHaveBeenCalled();
    expect(perps.signCarryRiskMandate).not.toHaveBeenCalled();
    expect(api.createCarryPosition).not.toHaveBeenCalled();
  });

  it("keeps the selected pair usable when the three-venue fleet matrix is not ready", async () => {
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [] });
    api.preflightCarryExecutionMatrix.mockResolvedValue({
      ...readyMatrix(),
      no_submit_ready: false,
      readiness: undefined,
      failures: [
        "pair_check_failed:1:carry_account_not_ready:aster",
        "pair_check_failed:3:carry_account_not_ready:aster",
      ],
      pairs: [
        { long_venue_id: "hyperliquid", short_venue_id: "aster", no_submit_ready: false, error_code: "carry_account_not_ready:aster" },
        { long_venue_id: "lighter", short_venue_id: "hyperliquid", no_submit_ready: true, error_code: null },
        { long_venue_id: "aster", short_venue_id: "lighter", no_submit_ready: false, error_code: "carry_account_not_ready:aster" },
      ],
    });
    api.preflightCarryPair.mockResolvedValue({
      correlation_id: "ghola-pair-isolated-1234",
      no_submit_ready: true,
      capital_ready: false,
      live_creation_ready: false,
      qualification_pilot_ready: false,
      creation_opportunity: { eligible: false },
    });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    await click("NO-SUBMIT CHECK");
    expect(api.preflightCarryExecutionMatrix).toHaveBeenCalledOnce();
    expect(api.preflightCarryPair).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("PAIR PAIR-ISOLATE");
    expect(container.textContent).toContain("FLEET 1/3 · ASTER BLOCKED");
    expect(container.textContent).toContain("1/3 PAIRS · ASTER BLOCKED");
  });

  it("does not poll private Carry state before Ghola authentication", async () => {
    auth.authenticated = false;
    await act(async () => {
      root.render(
        <CarryTerminalBuilder
          candidate={candidate()}
          autoRunNoSubmit
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("CONNECT TO VERIFY & TRADE");
    expect(container.textContent).toContain("SHADOW POSITION · LIVE-DATA MODEL");
    expect(container.textContent).toContain("NO WALLET · NO DEPOSIT · NO ORDER");
    expect(container.textContent).toContain("RISK MANDATE");
    expect(container.textContent).toContain("EXIT ≤0BP · 2 FLIPS · ≥6.0H · OWNER MOVES");
    expect(container.textContent).toContain("LIQUIDATION");
    expect(container.textContent).toContain("HYP 0BP · LTR 1BP");
    expect(container.textContent).not.toContain("RETRY POSITION SYNC");
    expect(container.textContent).not.toContain("NO-SUBMIT CHECK");
    expect(api.listCarryPositions).not.toHaveBeenCalled();
    expect(api.getCarryExecutionReadiness).not.toHaveBeenCalled();
    expect(api.getCarryPortfolioCapitalPlan).not.toHaveBeenCalled();
    expect(api.getCarryCollateralReview).not.toHaveBeenCalled();
    expect(api.getCarryPortfolioValueReport).not.toHaveBeenCalled();
    expect(api.preflightCarryPair).not.toHaveBeenCalled();
    expect(api.preflightCarryExecutionMatrix).not.toHaveBeenCalled();
  });

  it("does not invite trading when the public route has no modeled net edge", async () => {
    auth.authenticated = false;
    await act(async () => {
      root.render(<CarryTerminalBuilder candidate={{ ...candidate(), grossAnnualBps: 0 }} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("CONNECT TO VERIFY · NO EDGE YET");
    expect(container.textContent).not.toContain("CONNECT TO VERIFY & TRADE");
  });

  it("fails closed when the visible risk mandate is malformed", () => {
    expect(carryRiskMandateSummary({
      ...defaultCarryRiskMandate(),
      min_margin_runway_ms: 0,
    })).toEqual({ value: "UNVERIFIED", tone: "bad" });
  });

  it("fails closed when either leg lacks verified liquidation economics", () => {
    expect(carryLiquidationSummary({
      ...candidate(),
      short: { ...candidate().short, liquidation_fee_bps: null },
    })).toEqual({ value: "UNVERIFIED", tone: "bad" });
  });

  it("restores fresh diagnostic-only fleet evidence after refresh without treating it as readiness", async () => {
    const now = Date.now();
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [] });
    api.getCarryExecutionReadiness.mockResolvedValue({
      ready: false,
      reasons: ["carry_readiness_evidence_missing"],
      diagnostic: {
        version: 1,
        available: true,
        diagnostic_only: true,
        reusable_for_readiness: false,
        mode: "carry_execution_no_submit_matrix_diagnostic",
        asset: "BTC",
        notional_usd: "11",
        horizon_days: "30",
        image_digest: "sha256:abcdef123456",
        registry_venue_ids: ["hyperliquid", "lighter", "aster"],
        checked_at_ms: now - 120_000,
        expires_at_ms: now + 60_000,
        transaction_broadcast: false,
        diagnostic_commitment: "carry:diagnostic:evidence:abcdef123456",
        pairs: [
          { long_venue_id: "hyperliquid", short_venue_id: "aster", no_submit_ready: false, transaction_broadcast: false, error_code: "carry_account_not_ready:aster" },
          { long_venue_id: "lighter", short_venue_id: "hyperliquid", no_submit_ready: true, transaction_broadcast: false, error_code: null },
          { long_venue_id: "aster", short_venue_id: "lighter", no_submit_ready: false, transaction_broadcast: false, error_code: "carry_account_not_ready:aster" },
        ],
        failures: [
          "pair_check_failed:1:carry_account_not_ready:aster",
          "pair_check_failed:3:carry_account_not_ready:aster",
        ],
      },
    });

    await act(async () => {
      root.render(<CarryTerminalBuilder candidate={candidate()} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("1/3 PAIRS · ASTER BLOCKED · 2M");
    expect(container.textContent).toContain("NO-SUBMIT CHECK");
    expect(container.textContent).not.toContain("FLEET READY");
    const remediation = [...container.querySelectorAll("a")].find((item) => item.textContent === "CONNECT FLEET");
    expect(remediation?.getAttribute("href")).toContain("setup=carry");
    expect(remediation?.getAttribute("href")).not.toContain("long_venue=");
    expect(remediation?.getAttribute("href")).not.toContain("short_venue=");
    expect(api.preflightCarryExecutionMatrix).not.toHaveBeenCalled();
  });

  it("consumes the setup handoff once and runs only the no-submit proof", async () => {
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [] });
    api.preflightCarryPair.mockResolvedValue({
      correlation_id: "ghola-pair-auto-1234",
      no_submit_ready: true,
      live_creation_ready: false,
      qualification_pilot_ready: false,
      creation_opportunity: { eligible: false },
    });
    const consumed = vi.fn();

    await act(async () => {
      root.render(
        <CarryTerminalBuilder
          candidate={candidate()}
          autoRunNoSubmit
          onAutoRunNoSubmitConsumed={consumed}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(consumed).toHaveBeenCalledOnce();
    expect(api.preflightCarryExecutionMatrix).toHaveBeenCalledOnce();
    expect(api.preflightCarryPair).toHaveBeenCalledOnce();
    expect(api.createCarryPosition).not.toHaveBeenCalled();
    expect(api.executeCarryPositionEntry).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <CarryTerminalBuilder
          candidate={candidate()}
          autoRunNoSubmit
          onAutoRunNoSubmitConsumed={consumed}
        />,
      );
      await Promise.resolve();
    });
    expect(api.preflightCarryExecutionMatrix).toHaveBeenCalledOnce();
    expect(api.preflightCarryPair).toHaveBeenCalledOnce();
  });

  it("restores fresh deployment-bound readiness after refresh without rerunning the three-venue matrix", async () => {
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [] });
    api.getCarryExecutionReadiness.mockResolvedValue(readyReadiness());
    api.preflightCarryPair.mockResolvedValue({
      correlation_id: "ghola-pair-restored-1234",
      no_submit_ready: true,
      live_creation_ready: false,
      qualification_pilot_ready: false,
      creation_opportunity: { eligible: false, contract_data_skew_ms: 200, index_price_divergence_bps: 2 },
    });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    expect(api.getCarryExecutionReadiness).toHaveBeenCalledWith({
      asset: "BTC",
      notional_usd: "11",
      horizon_days: "30",
    });
    expect(container.textContent).toContain("CHECK PAIR · FLEET READY");
    await click("CHECK PAIR · FLEET READY");
    expect(api.preflightCarryExecutionMatrix).not.toHaveBeenCalled();
    expect(api.preflightCarryPair).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("FLEET CARRY:READIN");
  });

  it("proves the capital-free connection while keeping live entry locked", async () => {
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [] });
    api.preflightCarryExecutionMatrix.mockResolvedValue({
      ...readyMatrix(),
      capital_ready: false,
      readiness: { ...readyReadiness(), capital_ready: false },
    });
    api.preflightCarryPair.mockResolvedValue({
      correlation_id: "ghola-pair-unfunded-1234",
      no_submit_ready: true,
      capital_ready: false,
      live_creation_ready: false,
      qualification_pilot_ready: false,
      account_readiness: ["hyperliquid", "lighter"].map((venue_id) => ({
        venue_id,
        opening_collateral_shortfall_micro_usdc: 11_000_000,
      })),
      opening_capital_plan: {
        proposal_only: true,
        live_execution_leverage_unchanged: true,
        owner_only_funding: true,
        automatic_transfer_permitted: false,
        transaction_broadcast: false,
        total_required_opening_collateral_micro_usdc: 22_000_000,
        total_stress_adjusted_target_collateral_micro_usdc: 20_000_000,
        total_potential_releasable_collateral_micro_usdc: 2_000_000,
        legs: ["hyperliquid", "lighter"].map((venue_id) => ({
          venue_id,
          owner_maximum_stress_adjusted_leverage: 1,
        })),
      },
      creation_opportunity: { eligible: false },
    });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    await click("NO-SUBMIT CHECK");
    expect(container.textContent).toContain("CONNECTED · exact owner funding shortfall shown; no order submitted");
    expect(container.textContent).toContain("HYPERLIQUID $11 · LIGHTER $11 · OWNER");
    expect(container.textContent).toContain("STRESS CAPITAL · $20 TARGET / $22 1× · UP TO 1× OWNER CONFIG · $2 POTENTIAL");
    expect(api.createCarryPosition).not.toHaveBeenCalled();
    expect(api.executeCarryPositionEntry).not.toHaveBeenCalled();
  });

  it("surfaces the exact failed venue and correlation receipt", async () => {
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [] });
    api.preflightCarryPair.mockRejectedValue(Object.assign(
      new Error("lighter_account_not_ready"),
      { correlationId: "ghola-lighter-ref-1234" },
    ));
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    await click("NO-SUBMIT CHECK");
    expect(container.textContent).toContain("NO-SUBMIT RECEIPT");
    expect(container.textContent).toContain("LIGHTER NOT READY");
    expect(container.textContent).toContain("REF LIGHTER-REF-");
  });

  it("scopes first-time setup to the selected pair and returns to the same terminal route", async () => {
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [] });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    const link = [...container.querySelectorAll("a")].find((item) => item.textContent === "CONNECT PAIR");
    const setup = new URL(link?.getAttribute("href") || "", "https://ghola.local");
    expect(setup.searchParams.get("setup")).toBe("carry");
    expect(setup.searchParams.get("long_venue")).toBe("hyperliquid");
    expect(setup.searchParams.get("short_venue")).toBe("lighter");
    expect(setup.searchParams.get("return_to")).toContain("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open");
    expect(setup.searchParams.get("return_to")).toContain("long_venue=hyperliquid&short_venue=lighter");
  });

  it("routes a fresh owner to unified setup instead of failing position creation", async () => {
    perps.authenticated = false;
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [] });
    api.preflightCarryPair.mockResolvedValue({
      no_submit_ready: true,
      live_creation_ready: true,
      creation_opportunity: {
        checked_at_ms: Date.now(),
        eligible: true,
        worker_authentication: { evidence_commitment: OPPORTUNITY_EVIDENCE },
      },
    });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    await click("NO-SUBMIT CHECK");

    const link = [...container.querySelectorAll("a")].find((item) => item.textContent === "FINISH CARRY SETUP");
    const setup = new URL(link?.getAttribute("href") || "", "https://ghola.local");
    expect(setup.searchParams.get("setup")).toBe("carry");
    expect(setup.searchParams.get("long_venue")).toBe("hyperliquid");
    expect(setup.searchParams.get("short_venue")).toBe("lighter");
    expect(api.createCarryPosition).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("NOT SAVED");
  });

  it("turns wallet provisioning failure into a resumable setup action", async () => {
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [] });
    api.preflightCarryPair.mockResolvedValue({
      no_submit_ready: true,
      live_creation_ready: true,
      creation_opportunity: {
        checked_at_ms: Date.now(),
        eligible: true,
        worker_authentication: { evidence_commitment: OPPORTUNITY_EVIDENCE },
      },
    });
    perps.ensureWalletPair.mockRejectedValue(new Error(
      "Turnkey signed you in, but wallet provisioning failed.",
    ));
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    await click("NO-SUBMIT CHECK");
    await click("SAVE POSITION");

    expect(container.textContent).toContain("SETUP REQUIRED");
    expect([...container.querySelectorAll("a")].some((item) => item.textContent === "FINISH CARRY SETUP")).toBe(true);
    expect(api.createCarryPosition).not.toHaveBeenCalled();
  });

  it("allows a new Carry Position after the previous route proved flat with zero orders", async () => {
    api.listCarryPositions.mockResolvedValue({
      ok: true,
      records: [{
        ...carryRecord(),
        position: { ...carryRecord().position, status: "reconciled" },
        final_reconciliation_evidence: flatEvidence(["hyperliquid", "lighter"]),
      }],
    });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    expect(container.textContent).toContain("LAST FLAT · 0 ORDERS");
    expect([...container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("NO-SUBMIT CHECK"))).toBe(true);
  });

  it("does not claim flat from aggregate-only reconciliation", async () => {
    api.listCarryPositions.mockResolvedValue({
      ok: true,
      records: [{
        ...carryRecord(),
        position: { ...carryRecord().position, status: "reconciled" },
        final_reconciliation_evidence: {
          gross_exposure_micro_usdc: 0,
          open_order_count: 0,
          account_state_checked: true,
        },
      }],
    });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    expect(container.textContent).not.toContain("LAST FLAT · 0 ORDERS");
  });

  it("binds a replacement signature to the selected flat migration parent", async () => {
    const parent = {
      ...carryRecord(),
      position: {
        ...carryRecord().position,
        position_id: "carry:position:parent",
        long_venue_id: "aster",
        short_venue_id: "hyperliquid",
        status: "reconciled",
        pending_migration: {
          status: "owner_signature_required",
          selected_candidate: {
            candidate_id: "carry:migration:selected:0001",
            long_venue_id: "hyperliquid",
            short_venue_id: "lighter",
          },
        },
      },
      final_reconciliation_evidence: flatEvidence(["aster", "hyperliquid"]),
    };
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [parent] });
    api.preflightCarryPair.mockResolvedValue({
      no_submit_ready: true,
      live_creation_ready: true,
      creation_opportunity: {
        checked_at_ms: Date.now(),
        eligible: true,
        contract_data_skew_ms: 100,
        index_price_divergence_bps: 1,
        worker_authentication: { evidence_commitment: OPPORTUNITY_EVIDENCE },
      },
    });
    api.createCarryPosition.mockResolvedValue({ ok: true, record: carryRecord() });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    await click("NO-SUBMIT CHECK");
    expect(container.textContent).toContain("SIGN MIGRATION");
    await click("SIGN MIGRATION");
    expect(perps.signCarryRiskMandate).toHaveBeenCalledWith(expect.objectContaining({
      opportunity_evidence_commitment: OPPORTUNITY_EVIDENCE,
      migration_parent_position_id: "carry:position:parent",
      migration_candidate_id: "carry:migration:selected:0001",
    }));
    expect(api.createCarryPosition).toHaveBeenCalledWith(expect.objectContaining({
      position_input: expect.objectContaining({
        migration_parent_position_id: "carry:position:parent",
        migration_candidate_id: "carry:migration:selected:0001",
      }),
    }));
  });

  it("fails closed when the initial position sync is unavailable", async () => {
    api.listCarryPositions.mockRejectedValue(new Error("offline"));
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    expect(container.textContent).toContain("RETRY POSITION SYNC");
    expect(container.textContent).not.toContain("NO-SUBMIT CHECK");
    expect(container.textContent).not.toContain("CONFIRM LIVE PAIRED ENTRY");
  });

  it("blocks a draft entry when monitoring, automatic exit, or recovery is degraded", async () => {
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [carryRecord()] });
    api.getCarryExecutionReadiness.mockResolvedValue({
      ...readyReadiness(),
      carry_supervision: {
        ...healthySupervision(),
        ready: false,
        status: "degraded",
        recovery: { status: "stalled", last_error_code: "multi_leg_recovery_stalled" },
      },
    });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    expect(container.textContent).toContain("RECOVERY DEGRADED");
    expect(container.textContent).toContain("RISK ENGINE NOT READY");
    expect(container.textContent).not.toContain("CONFIRM LIVE PAIRED ENTRY");
  });

  it("shows owner-only releasable collateral without implying an automatic transfer", async () => {
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [] });
    api.getCarryPortfolioCapitalPlan.mockResolvedValue({
      ok: true,
      plan: {
        version: 1,
        kind: "ghola_carry_portfolio_capital_plan",
        status: "balanced",
        position_count: 1,
        total_requested_micro_usdc: 0,
        total_potential_releasable_micro_usdc: 12_500_000,
        total_proposed_internal_reallocation_micro_usdc: 0,
        net_new_owner_capital_requested_micro_usdc: 0,
        total_proposed_allocation_micro_usdc: 0,
        total_uncovered_shortfall_micro_usdc: 0,
        capital_optimization_available: true,
        proposal_only: true,
        transaction_broadcast: false,
        automatic_transfer_permitted: false,
        owner_only_operations: ["fund", "transfer", "withdraw"],
      },
    });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    expect(container.textContent).toContain("PORTFOLIO CAPITAL · $12.5 RELEASABLE · OWNER ONLY");
  });

  it("shows the worst verified shared-account runway across the portfolio", () => {
    expect(carryPortfolioRunwaySummary({
      kind: "ghola_carry_portfolio_capital_plan",
      status: "owner_action_required",
      position_count: 2,
      proposal_only: true,
      transaction_broadcast: false,
      automatic_transfer_permitted: false,
      accounts: [
        {
          venue_id: "hyperliquid",
          aggregate_runway_ms: 7_200_000,
          aggregate_stress_burn_micro_usdc_per_hour: 5_000_000,
          target_runway_ms: 3_600_000,
          risk_action_required: false,
        },
        {
          venue_id: "lighter",
          aggregate_runway_ms: 3_600_000,
          aggregate_stress_burn_micro_usdc_per_hour: 10_000_000,
          target_runway_ms: 3_600_000,
          risk_action_required: false,
        },
      ],
    })).toEqual({ value: "LTR 1.0H · 2 ACCTS", tone: "warn" });
  });

  it("fails closed when portfolio runway evidence is internally inconsistent", () => {
    expect(carryPortfolioRunwaySummary({
      kind: "ghola_carry_portfolio_capital_plan",
      status: "balanced",
      position_count: 1,
      proposal_only: true,
      transaction_broadcast: false,
      automatic_transfer_permitted: false,
      accounts: [{
        venue_id: "lighter",
        aggregate_runway_ms: null,
        aggregate_stress_burn_micro_usdc_per_hour: 10_000_000,
        target_runway_ms: 3_600_000,
        risk_action_required: false,
      }],
    })).toEqual({ value: "UNVERIFIED", tone: "bad" });
  });

  it("shows compact live margin-runway evidence inside the terminal", async () => {
    api.getCarryPortfolioCapitalPlan.mockResolvedValue({
      ok: true,
      plan: {
        version: 1,
        kind: "ghola_carry_portfolio_capital_plan",
        status: "owner_action_required",
        position_count: 2,
        total_requested_micro_usdc: 25_000_000,
        total_potential_releasable_micro_usdc: 15_000_000,
        total_proposed_internal_reallocation_micro_usdc: 15_000_000,
        net_new_owner_capital_requested_micro_usdc: 10_000_000,
        total_proposed_allocation_micro_usdc: 0,
        total_uncovered_shortfall_micro_usdc: 10_000_000,
        proposal_only: true,
        transaction_broadcast: false,
        automatic_transfer_permitted: false,
        owner_only_operations: ["fund", "transfer", "withdraw"],
      },
    });
    api.getCarryPortfolioValueReport.mockResolvedValue({
      ok: true,
      report: {
        version: 1,
        kind: "ghola_carry_portfolio_value_report",
        value_proof_status: "mixed",
        position_count: 2,
        open_position_count: 1,
        finalized_position_count: 1,
        modeled: { net_value_micro_usdc: 25_000_000 },
        finalized_after_costs: {
          net_value_micro_usdc: 19_500_000,
          variance_from_modeled_micro_usdc: 4_500_000,
        },
        unfinalized: { modeled_net_value_micro_usdc: 10_000_000 },
        capital_efficiency: {
          status: "ready",
          missing_position_ids: [],
          potential_releasable_micro_usdc: 15_000_000,
          proposed_reallocation_micro_usdc: 15_000_000,
          potential_new_cash_avoided_micro_usdc: 15_000_000,
          new_owner_cash_requested_micro_usdc: 10_000_000,
          uncovered_shortfall_micro_usdc: 10_000_000,
          owner_approval_required: true,
          proposal_only: true,
        },
        valuation_asset: "USDC",
        funding_valuation_basis: "usdc_equivalent_at_ledger_ingestion",
        proposal_only: true,
        transaction_broadcast: false,
        automatic_transfer_permitted: false,
        owner_only_operations: ["fund", "transfer", "withdraw"],
      },
    });
    api.getCarryCollateralReview.mockResolvedValue({
      ok: true,
      review: {
        version: 1,
        kind: "ghola_carry_collateral_review",
        status: "signature_required",
        owner_signature_required: true,
        transfer_instructions: [{
          owner_signature_required: true,
          execution_authorized: false,
          transaction_broadcast: false,
          amount_micro_usdc: 15_000_000,
        }],
        funding_instructions: [],
        proposal_only: true,
        review_only: true,
        execution_authorized: false,
        fund_movement_authorized: false,
        transaction_broadcast: false,
        automatic_transfer_permitted: false,
        withdrawal_permitted: false,
        trade_permitted: false,
      },
    });
    api.listCarryPositions.mockResolvedValue({
      ok: true,
      records: [{
        ...carryRecord(),
        position: { ...carryRecord().position, status: "active" },
        value_ledger: {
          status: "finalized",
          modeled: { net_value_micro_usdc: 15_000_000 },
          realized: {
            net_value_micro_usdc: 19_500_000,
            variance_from_modeled_micro_usdc: 4_500_000,
            attribution: {
              status: "finalized",
              trading_fee_micro_usdc: 500_000,
              slippage_micro_usdc: -250_000,
            },
          },
        },
        latest_observation: {
          expected_net_value_bps: 8,
          margin_runway_ms_by_venue: { hyperliquid: 7_200_000, lighter: 3_600_000 },
          margin_runway_status_by_venue: { hyperliquid: "healthy", lighter: "warning" },
          capital_action_plan: {
            status: "owner_action_required",
            minimum_additional_collateral_micro_usdc: 10_000_000,
            transaction_broadcast: false,
            automatic_transfer_permitted: false,
            legs: [
              { venue_id: "hyperliquid", recommended_action: "none" },
              { venue_id: "lighter", recommended_action: "owner_fund_venue" },
            ],
          },
          recorded_at_ms: Date.now(),
        },
      }],
    });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    expect(container.textContent).toContain("LEG RUNWAY");
    expect(container.textContent).toContain("HYP 2.0H · LTR 1.0H · WARNING");
    expect(container.textContent).toContain("CAPITAL");
    expect(container.textContent).toContain("$10 → LIGHTER · OWNER");
    expect(container.textContent).toContain("LEDGER");
    expect(container.textContent).toContain("$19.5 REAL · +$4.5 Δ");
    expect(container.textContent).toContain("EXEC Δ");
    expect(container.textContent).toContain("FEE +$0.5 · SLIP −$0.25");
    expect(container.textContent).toContain("MONITOR");
    expect(container.textContent).toContain("0S AGO");
    expect(container.textContent).toContain("PORTFOLIO CAPITAL · $15 REALLOCATE · $10 NEW CASH · OWNER ONLY");
    expect(container.textContent).toContain("COLLATERAL REVIEW · 1 MOVE · 0 FUND · $15 · REVIEW ONLY");
    expect(container.textContent).toContain("SIGN CAPITAL REVIEW");
    expect(container.textContent).toContain("PORTFOLIO VALUE · $19.5 REAL · $10 OPEN MODEL · +$4.5 Δ · USDC @ BOOKED FX");
    expect(container.textContent).toContain("CAPITAL OFFSET · $15 NEW CASH AVOIDED · OWNER MOVE");
  });

  it("fails closed when a venue claims risk alongside an infinite runway", async () => {
    api.listCarryPositions.mockResolvedValue({
      ok: true,
      records: [{
        ...carryRecord(),
        position: { ...carryRecord().position, status: "active" },
        latest_observation: {
          margin_runway_ms_by_venue: { hyperliquid: null, lighter: 3_600_000 },
          margin_runway_status_by_venue: { hyperliquid: "warning", lighter: "healthy" },
          recorded_at_ms: Date.now(),
        },
      }],
    });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    const label = [...container.querySelectorAll("p")].find((item) => item.textContent === "LEG RUNWAY");
    expect(label?.parentElement?.textContent).toContain("UNVERIFIED");
  });

  it("shows the deterministic funding-flip count before reduce-only exit", async () => {
    api.listCarryPositions.mockResolvedValue({
      ok: true,
      records: [{
        ...carryRecord(),
        position: {
          ...carryRecord().position,
          status: "active",
          consecutive_exit_observations: 1,
        },
        latest_observation: {
          expected_net_value_bps: -1,
          margin_runway_ms_by_venue: { hyperliquid: 7_200_000, lighter: 3_600_000 },
          margin_runway_status_by_venue: { hyperliquid: "healthy", lighter: "healthy" },
          recorded_at_ms: Date.now(),
        },
      }],
    });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    expect(container.textContent).toContain("CARRY SIGNAL");
    expect(container.textContent).toContain("−1BP · 1/2 FLIPS");
    expect(api.requestCarryPositionExit).not.toHaveBeenCalled();
  });

  it("fails closed when capital-efficiency evidence is incomplete or inconsistent", () => {
    const report = {
      kind: "ghola_carry_portfolio_value_report",
      position_count: 1,
      proposal_only: true,
      transaction_broadcast: false,
      automatic_transfer_permitted: false,
      owner_only_operations: ["fund", "transfer", "withdraw"],
    };
    expect(carryCapitalEfficiencySummary({
      ...report,
      capital_efficiency: {
        status: "incomplete",
        missing_position_ids: ["carry:position:missing"],
        potential_releasable_micro_usdc: null,
        proposed_reallocation_micro_usdc: null,
        potential_new_cash_avoided_micro_usdc: null,
        new_owner_cash_requested_micro_usdc: null,
        uncovered_shortfall_micro_usdc: null,
        owner_approval_required: false,
        proposal_only: true,
      },
    })?.value).toBe("1 POSITION NEED FRESH MONITORING");
    expect(carryCapitalEfficiencySummary({
      ...report,
      capital_efficiency: {
        status: "ready",
        potential_releasable_micro_usdc: 15_000_000,
        proposed_reallocation_micro_usdc: 15_000_000,
        potential_new_cash_avoided_micro_usdc: 14_000_000,
        new_owner_cash_requested_micro_usdc: 10_000_000,
        uncovered_shortfall_micro_usdc: 10_000_000,
        owner_approval_required: true,
        proposal_only: true,
      },
    })?.value).toBe("UNVERIFIED");
  });

  it("does not label portfolio P&L real without its worker-bound FX basis", () => {
    expect(carryPortfolioValueSummary({
      kind: "ghola_carry_portfolio_value_report",
      value_proof_status: "finalized",
      position_count: 1,
      open_position_count: 0,
      finalized_position_count: 1,
      modeled: { net_value_micro_usdc: 20_000_000 },
      finalized_after_costs: {
        net_value_micro_usdc: 19_500_000,
        variance_from_modeled_micro_usdc: -500_000,
      },
      unfinalized: { modeled_net_value_micro_usdc: 0 },
      proposal_only: true,
      transaction_broadcast: false,
      automatic_transfer_permitted: false,
      owner_only_operations: ["fund", "transfer", "withdraw"],
    })).toEqual({ value: "UNVERIFIED FX BASIS", tone: "bad" });
  });

  it("shows fresh account-state proof after an approved capital plan restores safe runway", async () => {
    api.listCarryPositions.mockResolvedValue({ ok: true, records: [] });
    api.getCarryCollateralReview.mockResolvedValue({
      ok: true,
      review: {
        version: 1,
        kind: "ghola_carry_collateral_review",
        status: "no_action",
        owner_signature_required: false,
        transfer_instructions: [],
        funding_instructions: [],
        proposal_only: true,
        review_only: true,
        execution_authorized: false,
        fund_movement_authorized: false,
        transaction_broadcast: false,
        automatic_transfer_permitted: false,
        withdrawal_permitted: false,
        trade_permitted: false,
      },
      outcome_receipt: {
        status: "safe_runway_verified",
        capital_outcome_verified: true,
        account_state_checked: true,
        fund_movement_verified: false,
        transaction_broadcast: false,
      },
    });
    await act(async () => root.render(<CarryTerminalBuilder candidate={candidate()} />));
    expect(container.textContent).toContain("SAFE RUNWAY VERIFIED · NO FUNDS MOVED");
  });

  it("summarizes monitoring, automatic-exit, and recovery supervision independently", () => {
    expect(carrySupervisionSummary(healthySupervision())).toEqual({
      ready: true,
      value: "DATA/MON/EXIT/REC LIVE",
      tone: "good",
    });
    expect(carrySupervisionSummary({
      status: "degraded",
      monitoring: { status: "failed" },
      execution: { status: "degraded" },
      recovery: { status: "healthy" },
      observation: { status: "healthy" },
    })).toEqual({
      ready: false,
      value: "MONITOR + EXIT DEGRADED",
      tone: "bad",
    });
    expect(carrySupervisionSummary({
      status: "degraded",
      monitoring: { status: "stalled" },
      execution: { status: "healthy" },
      recovery: { status: "healthy" },
      observation: { status: "healthy" },
    })).toEqual({
      ready: false,
      value: "MONITOR DEGRADED",
      tone: "bad",
    });
    expect(carrySupervisionSummary({
      ready: true,
      status: "healthy",
      monitoring: { status: "healthy" },
      execution: { status: "healthy" },
      recovery: { status: "healthy" },
    })).toEqual({
      ready: false,
      value: "UNVERIFIED",
      tone: "warn",
    });
  });

  async function click(label: string) {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
    expect(button, `missing button: ${label}`).toBeTruthy();
    await act(async () => {
      button!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});

function candidate(): CarryCandidate {
  return {
    asset: "BTC",
    long: snapshot("hyperliquid", 10_000_000),
    short: snapshot("lighter", 40_000_000),
    grossAnnualBps: 2628,
    exact: true,
  };
}

function snapshot(venueId: string, funding: number) {
  return {
    venue_id: venueId,
    contract_id: `${venueId}:BTC`,
    economic_equivalence_id: "carry:BTC-usd-linear",
    asset: "BTC",
    market: "BTC-USD",
    quote_asset: "USDC",
    collateral_asset: "USDC",
    contract_type: "linear_perp" as const,
    status: "ready" as const,
    stale: false,
    funding_rate_e12_per_interval: funding,
    funding_interval_ms: 3_600_000,
    maker_fee_bps: 1,
    taker_fee_bps: 2,
    minimum_notional_micro_usdc: 5_000_000,
    initial_margin_bps: 500,
    maintenance_margin_bps: 250,
    liquidation_fee_bps: venueId === "hyperliquid" ? 0 : 1,
    liquidation_model: "account_equity_below_maintenance_margin",
    mark_price_e8: 6_000_000_000_000,
    index_price_e8: 6_000_000_000_000,
    best_bid_e8: 5_999_900_000_000,
    best_ask_e8: 6_000_100_000_000,
    depth_bids: [{ price_e8: 5_999_900_000_000, size_e8: 100_000_000 }],
    depth_asks: [{ price_e8: 6_000_100_000_000, size_e8: 100_000_000 }],
    depth_observed_at_ms: Date.now(),
    as_of_ms: Date.now(),
    missing_fields: [],
  };
}

function readyFundingPersistence() {
  return {
    version: 1,
    ready: true,
    reasons: [],
    sample_count: 8,
    minimum_samples: 8,
    observed_span_ms: 2_100_000,
    minimum_span_ms: 1_800_000,
    conservative_hourly_spread_e12: 100_000_000,
    evidence_commitment: `carry:funding:${"a".repeat(64)}`,
  };
}

function readyMatrix() {
  return {
    correlation_id: "ghola-matrix-test-1234",
    mode: "carry_execution_no_submit_matrix",
    no_submit_ready: true,
    transaction_broadcast: false,
    failures: [],
    venues: ["hyperliquid", "lighter", "aster"].map((venue_id) => ({
      venue_id,
      transaction_broadcast: false,
    })),
    readiness: readyReadiness(),
    carry_supervision: healthySupervision(),
  };
}

function healthySupervision() {
  return {
    ready: true,
    status: "healthy",
    monitoring: { status: "healthy", run_count: 2, consecutive_failures: 0 },
    execution: { status: "healthy", run_count: 2, consecutive_failures: 0 },
    recovery: { status: "healthy", run_count: 2, consecutive_failures: 0 },
    observation: { status: "healthy", run_count: 2, consecutive_failures: 0 },
  };
}

function readyReadiness() {
  return {
    ready: true,
    network: "mainnet",
    asset: "BTC",
    notional_usd: "11",
    horizon_days: "30",
    image_digest: "sha256:abcdef123456",
    registry_venue_ids: ["hyperliquid", "lighter", "aster"],
    expires_at_ms: Date.now() + 60_000,
    evidence_commitment: "carry:readiness:evidence:abcdef123456",
  };
}

function privatePrimeReadiness() {
  const now = Date.now();
  const readiness = {
    version: 1,
    kind: "ghola_private_prime_no_submit_readiness",
    ready: true,
    no_submit_ready: true,
    ready_for_live_users: false,
    live_launch_blockers: ["live_paired_lifecycle_unproven"],
    proof_level: "pre_broadcast_readiness",
    checked_at_ms: now,
    expires_at_ms: now + 5_000,
    asset: "BTC",
    five_venue_shadow: { ready: true, venue_count: 5 },
    three_venue_execution: {
      ready: true,
      venue_ids: ["hyperliquid", "lighter", "aster"],
      capital_ready: true,
    },
    failure_recovery: {
      ready: true,
      venue_ids: ["hyperliquid", "lighter", "aster"],
      reasons: [],
      policy: {
        ambiguous_submission: "freeze_reconcile_never_retry",
        partial_fill: "exact_quantity_reduce_only",
        worker_restart: "reconcile_before_action",
      },
    },
    collateral_route_observation: {
      configured: true,
      verified: true,
      route_count: 6,
      required_route_count: 6,
      available_route_count: 6,
      complete_directed_coverage: true,
      checked_at_ms: now,
      expires_at_ms: now + 30_000,
      evidence_commitment: "carry:transfer-routes:evidence:abcdef123456",
      read_only: true,
      owner_approval_required: true,
      fund_movement_authorized: false,
      transaction_broadcast: false,
      automatic_transfer_permitted: false,
    },
    supervision: {
      ready: true,
      status: "healthy",
      checked_at_ms: now,
      evidence_commitment: `carry:supervision:evidence:${"a".repeat(64)}`,
    },
    live_paired_lifecycle_proven: false,
    owner_only_funding: true,
    owner_only_transfers: true,
    owner_only_withdrawals: true,
    transaction_broadcast: false,
    reasons: [],
  };
  return {
    ...readiness,
    evidence_commitment: carryPrivatePrimeEvidenceCommitment(readiness),
  };
}

function carryRecord() {
  return {
    qualification_pilot: { enabled: true, candidate_venue_id: "lighter" },
    position: {
      position_id: "carry:position:test",
      asset: "BTC",
      long_venue_id: "hyperliquid",
      short_venue_id: "lighter",
      target_notional_micro_usdc: 11_000_000,
      status: "draft",
      next_actions: ["run_preflight"],
      last_event_sequence: 0,
      consecutive_exit_observations: 0,
      risk_mandate: {
        exit_net_value_bps: 0,
        exit_after_consecutive_observations: 2,
      },
    },
  };
}

function flatEvidence(venueIds: string[]) {
  return {
    owner_commitment: "owner:carry:web-terminal:0001",
    carry_position_id: "carry:position:web-terminal:0001",
    gross_exposure_micro_usdc: 0,
    open_order_count: 0,
    account_state_checked: true,
    transaction_broadcast: false,
    checked_at_ms: 1_800_000_000_000,
    reconciliation_commitment: "carry:reconciliation:web-terminal:0001",
    venues: venueIds.map((venue_id) => ({
      venue_id,
      account_commitment: `account:${venue_id}:web-terminal:0001`,
      authorized: true,
      flat_zero_orders: true,
      position_count: 0,
      open_order_count: 0,
      account_state_checked: true,
    })),
  };
}
