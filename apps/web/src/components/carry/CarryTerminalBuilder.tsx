"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  approveCarryCollateralReview,
  createCarryPosition,
  executeCarryPositionEntry,
  getCarryCollateralReview,
  getCarryExecutionReadiness,
  getCarryPortfolioCapitalPlan,
  getCarryPortfolioValueReport,
  getPrivateAgentPassport,
  listCarryPositions,
  preflightCarryExecutionMatrix,
  preflightCarryPair,
  requestCarryPositionExit,
} from "@/lib/private-account-client";
import {
  buildCarryRiskMandatePayload,
  carryRiskMandateAuthorization,
  defaultCarryRiskMandate,
} from "@/lib/carry-risk-mandate";
import { buildCarryCollateralReviewAuthorization } from "@/lib/carry-collateral-review";
import { carryPrivatePrimeSummary } from "@/lib/carry-private-prime-readiness";
import {
  builderModel,
  CARRY_VENUE_LABELS,
  type CarryCandidate,
  type CarryQuoteModel,
} from "@/lib/carry-market";
import { hasExactCarryFlatReconciliation } from "@/lib/carry-reconciliation";
import {
  CARRY_EXECUTION_VENUES,
  isCarryExecutionVenue,
  type CarryExecutionVenue,
} from "@/lib/carry-venues";
import { usePerpsTurnkey } from "@/lib/perps-turnkey-provider";
import { useThumperAuth } from "@/lib/thumper-auth-context";

type CarryRecord = {
  qualification_pilot?: { enabled?: boolean; candidate_venue_id?: string };
  value_boundary_authoritative?: boolean;
  position: {
    position_id: string;
    asset: string;
    long_venue_id: string;
    short_venue_id: string;
    target_notional_micro_usdc: number;
    status: string;
    next_actions: string[];
    last_event_sequence: number;
    active_boundary_provenance?: string | null;
    consecutive_exit_observations?: number;
    risk_mandate?: {
      exit_net_value_bps?: number;
      exit_after_consecutive_observations?: number;
    };
    migration_parent_position_id?: string;
    migration_candidate_id?: string;
    pending_migration?: {
      status?: string;
      selected_candidate?: {
        candidate_id?: string;
        long_venue_id?: string;
        short_venue_id?: string;
      };
    };
  };
  final_reconciliation_evidence?: {
    gross_exposure_micro_usdc?: number;
    open_order_count?: number;
    account_state_checked?: boolean;
    transaction_broadcast?: boolean;
    checked_at_ms?: number;
    reconciliation_commitment?: string;
    venues?: Array<{
      venue_id?: string;
      authorized?: boolean;
      flat_zero_orders?: boolean;
      position_count?: number;
      open_order_count?: number;
      account_state_checked?: boolean;
    }>;
  };
  value_ledger?: {
    status?: "open" | "finalized";
    modeled?: { net_value_micro_usdc?: number };
    realized?: {
      net_value_micro_usdc?: number;
      variance_from_modeled_micro_usdc?: number;
      attribution?: {
        status?: "accruing" | "finalized" | "net_only" | "finalized_net_only";
        trading_fee_micro_usdc?: number | null;
        slippage_micro_usdc?: number | null;
      };
    };
  };
  latest_observation?: {
    expected_net_value_bps?: number;
    contract_data_skew_ms?: number;
    max_contract_data_skew_ms?: number;
    index_price_divergence_bps?: number;
    mark_price_divergence_bps?: number;
    max_index_price_divergence_bps?: number;
    max_mark_price_divergence_bps?: number;
    margin_runway_ms_by_venue?: Record<string, number | null>;
    margin_runway_status_by_venue?: Record<string, "healthy" | "warning" | "critical" | "breached">;
    capital_action_plan?: {
      status?: "balanced" | "owner_action_required" | "exit_required" | "quarantined";
      minimum_additional_collateral_micro_usdc?: number;
      transaction_broadcast?: boolean;
      automatic_transfer_permitted?: boolean;
      legs?: Array<{
        venue_id?: string;
        recommended_action?: "none" | "owner_fund_venue" | "owner_review_required" | "reduce_only_exit" | "reconcile_only";
      }>;
    } | null;
    recorded_at_ms?: number;
  };
};

const CARRY_CREATION_PROOF_MAX_AGE_MS = defaultCarryRiskMandate().max_data_age_ms;
const CARRY_CREATION_PROOF_FUTURE_TOLERANCE_MS = 5_000;

export const CarryTerminalBuilder = memo(function CarryTerminalBuilder({
  candidate,
  routeQualified = true,
  autoRunNoSubmit = false,
  onAutoRunNoSubmitStarted,
  onAutoRunNoSubmitResolved,
}: {
  candidate: CarryCandidate;
  routeQualified?: boolean;
  autoRunNoSubmit?: boolean;
  onAutoRunNoSubmitStarted?: () => void;
  onAutoRunNoSubmitResolved?: (outcome: "completed" | "auth_required") => void;
}) {
  const perpsTurnkey = usePerpsTurnkey();
  const auth = useThumperAuth();
  const privateSessionReady = auth.authenticated && !auth.loading;
  const [notional, setNotional] = useState("11");
  const [days, setDays] = useState("30");
  const [proof, setProof] = useState<Record<string, unknown> | null>(null);
  const [executionMatrix, setExecutionMatrix] = useState<Record<string, unknown> | null>(null);
  const [readiness, setReadiness] = useState<Record<string, unknown> | null>(null);
  const [records, setRecords] = useState<CarryRecord[]>([]);
  const [portfolioCapitalPlan, setPortfolioCapitalPlan] = useState<Record<string, unknown> | null>(null);
  const [collateralReview, setCollateralReview] = useState<Record<string, unknown> | null>(null);
  const [collateralApproval, setCollateralApproval] = useState<Record<string, unknown> | null>(null);
  const [collateralOutcome, setCollateralOutcome] = useState<Record<string, unknown> | null>(null);
  const [portfolioValueReport, setPortfolioValueReport] = useState<Record<string, unknown> | null>(null);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [busy, setBusy] = useState<"check" | "save" | "enter" | "exit" | "approve" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastCheckReceipt, setLastCheckReceipt] = useState<string | null>(null);
  const [noSubmitAuthRequired, setNoSubmitAuthRequired] = useState(false);
  const autoRunNoSubmitConsumedRef = useRef(false);
  const [saveSetupRequired, setSaveSetupRequired] = useState(false);
  const routeKey = `${candidate.asset}:${candidate.long.venue_id}:${candidate.short.venue_id}`;
  const model = useMemo(() => builderModel(candidate, notional, days), [candidate, days, notional]);
  const executionPair = isCarryExecutionVenue(candidate.long.venue_id)
    && isCarryExecutionVenue(candidate.short.venue_id);

  const loadRecords = useCallback(async () => {
    if (!privateSessionReady) {
      setRecords([]);
      setPortfolioCapitalPlan(null);
      setCollateralReview(null);
      setCollateralApproval(null);
      setCollateralOutcome(null);
      setPortfolioValueReport(null);
      setRecordsLoaded(!auth.loading);
      setRecordsLoading(false);
      return;
    }
    setRecordsLoading(true);
    try {
      const [recordsResult, capitalResult, reviewResult, valueResult] = await Promise.allSettled([
        listCarryPositions(),
        getCarryPortfolioCapitalPlan(0),
        getCarryCollateralReview(0),
        getCarryPortfolioValueReport(0),
      ]);
      if (recordsResult.status !== "fulfilled") throw new Error("carry_position_sync_failed");
      const result = asRecord(recordsResult.value);
      const next = Array.isArray(result.records) ? result.records.map(asRecord).filter(isCarryRecord) : [];
      setRecords(next);
      setRecordsLoaded(true);
      if (capitalResult.status === "fulfilled") {
        const capital = asRecord(capitalResult.value);
        setPortfolioCapitalPlan(capital.ok === true ? asRecord(capital.plan) : capital);
      } else {
        setPortfolioCapitalPlan(null);
      }
      if (reviewResult.status === "fulfilled") {
        const result = asRecord(reviewResult.value);
        setCollateralReview(result.ok === true ? asRecord(result.review) : result);
        setCollateralApproval(result.ok === true && result.approval_receipt ? asRecord(result.approval_receipt) : null);
        setCollateralOutcome(result.ok === true && result.outcome_receipt ? asRecord(result.outcome_receipt) : null);
      } else {
        setCollateralReview(null);
        setCollateralApproval(null);
        setCollateralOutcome(null);
      }
      if (valueResult.status === "fulfilled") {
        const value = asRecord(valueResult.value);
        setPortfolioValueReport(value.ok === true ? asRecord(value.report) : null);
      } else {
        setPortfolioValueReport(null);
      }
    } catch {
      // Preserve the last authoritative view and fail closed if the initial sync failed.
    } finally {
      setRecordsLoading(false);
    }
  }, [auth.loading, privateSessionReady]);

  useEffect(() => {
    if (!privateSessionReady) {
      void loadRecords();
      return;
    }
    let stopped = false;
    let timer: number | null = null;
    const refresh = async () => {
      await loadRecords();
      if (!stopped) timer = window.setTimeout(refresh, document.hidden ? 30_000 : 5_000);
    };
    void refresh();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loadRecords, privateSessionReady]);
  useEffect(() => {
    setProof(null);
    setExecutionMatrix(null);
    setMessage(null);
    setSaveSetupRequired(false);
  }, [routeKey]);
  useEffect(() => {
    if (!privateSessionReady) {
      setReadiness(null);
      setExecutionMatrix(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    const refresh = async () => {
      try {
        const value = await getCarryExecutionReadiness({
          asset: candidate.asset,
          notional_usd: notional,
          horizon_days: days,
        });
        if (cancelled) return;
        const next = asRecord(value);
        setReadiness(next);
        const diagnostic = asRecord(next.diagnostic);
        if (readyStoredDiagnostic(diagnostic, candidate.asset, notional, days)) {
          setExecutionMatrix((current) => matrixCheckedAtMs(diagnostic) > matrixCheckedAtMs(current)
            ? diagnostic
            : current);
        }
      } catch {
        if (!cancelled) setReadiness(null);
      } finally {
        if (!cancelled) timer = window.setTimeout(refresh, document.hidden ? 30_000 : 5_000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [candidate.asset, days, notional, privateSessionReady, routeKey]);

  const routeRecords = records.filter((record) => record.position.asset === candidate.asset
    && record.position.long_venue_id === candidate.long.venue_id
    && record.position.short_venue_id === candidate.short.venue_id);
  const current = routeRecords.find((record) =>
    !["reconciled", "manual_intervention"].includes(record.position.status)) || null;
  const lastFlat = routeRecords.some((record) => record.position.status === "reconciled"
    && hasExactCarryFlatReconciliation(record.final_reconciliation_evidence, [
      record.position.long_venue_id,
      record.position.short_venue_id,
    ]));
  const migrationSource = records.find((record) => {
    const selected = record.position.pending_migration?.selected_candidate;
    return record.position.status === "reconciled"
      && hasExactCarryFlatReconciliation(record.final_reconciliation_evidence, [
        record.position.long_venue_id,
        record.position.short_venue_id,
      ])
      && record.position.pending_migration?.status === "owner_signature_required"
      && selected?.long_venue_id === candidate.long.venue_id
      && selected?.short_venue_id === candidate.short.venue_id
      && record.position.asset === candidate.asset;
  }) || null;
  const migrationNotional = migrationSource?.position.target_notional_micro_usdc;
  useEffect(() => {
    if (!Number.isSafeInteger(migrationNotional) || Number(migrationNotional) <= 0) return;
    const exact = String(Number(migrationNotional) / 1_000_000);
    if (notional !== exact) {
      setNotional(exact);
      setProof(null);
    }
  }, [migrationNotional, notional]);
  const latestObservation = current?.latest_observation || null;
  const runway = carryRunwaySummary(latestObservation, candidate);
  const carrySignal = carryFundingFlipSummary(current?.position, latestObservation);
  const capital = carryCapitalSummary(latestObservation?.capital_action_plan);
  const ledger = carryLedgerSummary(current);
  const proofOpportunity = proof ? asRecord(proof.creation_opportunity) : null;
  const actionableProof = proof?.live_creation_ready === true || proof?.qualification_pilot_ready === true;
  const creationProofFreshness = carryCreationProofFreshness(proofOpportunity);
  const staleRouteMetric = { value: "STALE", tone: "warn" as const };
  const fundingPersistence = routeQualified
    ? carryFundingPersistenceSummary(proofOpportunity)
    : { value: "PAUSED", tone: "warn" as const, ready: false };
  const economics = routeQualified
    ? carryTerminalEconomics(model, proofOpportunity)
    : {
        fees: "—",
        slippage: "—",
        depth: "STALE",
        depthTone: "warn" as const,
        net: "—",
        netTone: undefined,
        breakEven: "—",
      };
  const grossFunding = routeQualified
    ? carryTerminalGrossFunding(candidate, proof ? proofOpportunity || {} : null)
    : staleRouteMetric;
  const venueMinimumMargin = routeQualified
    ? carryVenueMinimumMarginSummary(model, proof)
    : staleRouteMetric;
  const openingCapital = routeQualified
    ? carryOpeningCapitalSummary(model, proof)
    : staleRouteMetric;
  const collateralBasis = routeQualified
    ? carryCollateralBasisSummary(candidate, proofOpportunity)
    : staleRouteMetric;
  const liquidation = routeQualified ? carryLiquidationSummary(candidate) : staleRouteMetric;
  const stressCapital = routeQualified ? carryStressCapitalSummary(proof) : null;
  const portfolioCapital = carryPortfolioCapitalSummary(portfolioCapitalPlan);
  const portfolioRunway = carryPortfolioRunwaySummary(portfolioCapitalPlan);
  const collateral = carryCollateralReviewSummary(collateralReview);
  const portfolioValue = carryPortfolioValueSummary(portfolioValueReport);
  const capitalEfficiency = carryCapitalEfficiencySummary(portfolioValueReport);
  const displayedCapital = routeQualified
    ? latestObservation?.capital_action_plan ? capital : openingCapital
    : staleRouteMetric;
  const restoredReadiness = readyStoredReadiness(readiness, candidate.asset, notional, days);
  const fleetGuard = carryFleetGuardSummary(executionMatrix, restoredReadiness);
  const workerPrivatePrime = carryPrivatePrimeSummary(readiness?.private_prime_readiness);
  const privatePrime = !privateSessionReady
    ? { status: "pending" as const, value: "SIGN IN REQUIRED", detail: "AUTHENTICATE TO VERIFY" }
    : !recordsLoaded
      ? { status: "pending" as const, value: "SYNC REQUIRED", detail: "SYNC POSITIONS FIRST" }
      : workerPrivatePrime;
  const supervision = carrySupervisionSummary(asRecord(
    readiness?.carry_supervision || executionMatrix?.carry_supervision,
  ));
  const mandate = carryRiskMandateSummary(defaultCarryRiskMandate());

  useEffect(() => {
    if (!proof || !actionableProof) return;
    const expiresAtMs = creationProofFreshness.expires_at_ms;
    if (!creationProofFreshness.fresh || expiresAtMs === null) {
      setProof((current) => current === proof ? null : current);
      setMessage("CHECK EXPIRED · rerun the no-submit check before signing");
      return;
    }
    const timer = window.setTimeout(() => {
      setProof((current) => current === proof ? null : current);
      setMessage("CHECK EXPIRED · rerun the no-submit check before signing");
    }, Math.max(1, expiresAtMs - Date.now() + 1));
    return () => window.clearTimeout(timer);
  }, [actionableProof, creationProofFreshness.expires_at_ms, creationProofFreshness.fresh, proof]);

  const invalidateProof = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setProof(null);
    setExecutionMatrix(null);
    setMessage(null);
    setSaveSetupRequired(false);
  };

  const runCheck = useCallback(async (pairOnly = false): Promise<"completed" | "auth_required" | "blocked"> => {
    if (!executionPair || !privateSessionReady || !routeQualified) return "blocked";
    const localReference = shortReference(`ghola-${Date.now().toString(36)}`);
    const checkedRoute = `${candidate.asset} · L ${venueName(candidate.long.venue_id)} / S ${venueName(candidate.short.venue_id)}`;
    setBusy("check");
    setMessage(null);
    setProof(null);
    setExecutionMatrix(null);
    setNoSubmitAuthRequired(false);
    setLastCheckReceipt(`${checkedRoute} · CHECKING · REF ${localReference}`);
    let activeReadiness = restoredReadiness ? readiness : null;
    let matrix: Record<string, unknown> | null = null;
    try {
      let result: Record<string, unknown>;
      if (pairOnly || activeReadiness) {
        result = asRecord(await preflightCarryPair({
          asset: candidate.asset,
          long_venue_id: candidate.long.venue_id as CarryExecutionVenue,
          short_venue_id: candidate.short.venue_id as CarryExecutionVenue,
          notional_usd: notional,
          horizon_days: days,
        }));
      } else {
        matrix = asRecord(await preflightCarryExecutionMatrix({
          asset: candidate.asset,
          notional_usd: notional,
          horizon_days: days,
          selected_long_venue_id: candidate.long.venue_id as CarryExecutionVenue,
          selected_short_venue_id: candidate.short.venue_id as CarryExecutionVenue,
        }));
        setExecutionMatrix(matrix);
        const selectedPair = asRecord(matrix.selected_pair);
        const selectedResult = asRecord(selectedPair.result);
        if (Object.keys(selectedResult).length > 0) {
          result = selectedResult;
        } else if (Object.keys(selectedPair).length > 0) {
          throw new Error(stringValue(selectedPair.error_code) || "carry_selected_pair_not_ready");
        } else {
          result = asRecord(await preflightCarryPair({
            asset: candidate.asset,
            long_venue_id: candidate.long.venue_id as CarryExecutionVenue,
            short_venue_id: candidate.short.venue_id as CarryExecutionVenue,
            notional_usd: notional,
            horizon_days: days,
          }));
        }
      }
      if (matrix && readyNoSubmitMatrix(matrix, candidate.asset, notional, days)) {
        activeReadiness = {
          ...asRecord(matrix.readiness),
          private_prime_readiness: matrix.private_prime_readiness,
          shadow_qualification: matrix.shadow_qualification,
          carry_supervision: matrix.carry_supervision,
        };
        setReadiness(activeReadiness);
      } else if (!activeReadiness) {
        setReadiness(null);
      }
      setProof({
        ...result,
        ...(matrix ? { execution_matrix: matrix } : {}),
        ...(activeReadiness ? { execution_readiness: activeReadiness } : {}),
      });
      setSaveSetupRequired(false);
      const checkedFunding = carryFundingPersistenceSummary(asRecord(result.creation_opportunity));
      const outcome = result.live_creation_ready === true
        ? "READY · synchronized market data, exact costs, margin runway and both order shapes verified"
        : result.qualification_pilot_ready === true
          ? "PROOF READY · one capped qualification lifecycle can be armed"
          : result.no_submit_ready === true && result.capital_ready !== true
            ? "CONNECTED · exact owner funding shortfall shown; no order submitted"
          : result.no_submit_ready === true && checkedFunding.ready !== true
            ? `OBSERVING · ${checkedFunding.value} · no order submitted`
          : result.no_submit_ready === true
            ? "CHECKED · execution remains locked pending venue qualification"
            : "NOT READY · connect and fund both trade-only accounts";
      const matrixReference = activeReadiness
        ? shortReference(
          stringValue(matrix?.correlation_id)
          || stringValue(activeReadiness.evidence_commitment)
          || "ready",
        )
        : carryFleetGuardSummary(matrix, false).receipt;
      const pairReference = shortReference(stringValue(result.correlation_id) || localReference);
      setLastCheckReceipt(`${checkedRoute} · ${outcome} · PAIR ${pairReference} · FLEET ${matrixReference}`);
      return "completed";
    } catch (error) {
      const failure = carryCheckFailure(error, localReference);
      const matrixReference = carryFleetGuardSummary(matrix, Boolean(activeReadiness)).receipt;
      setLastCheckReceipt(`${checkedRoute} · ${failure.label} · REF ${failure.reference} · FLEET ${matrixReference}`);
      if (carryCheckAuthenticationRequired(error)) {
        setNoSubmitAuthRequired(true);
        setMessage("SIGN IN AGAIN · SESSION EXPIRED · NO ORDER SUBMITTED");
        return "auth_required";
      }
      return "completed";
    } finally {
      setBusy(null);
    }
  }, [
    candidate.asset,
    candidate.long.venue_id,
    candidate.short.venue_id,
    days,
    executionPair,
    notional,
    privateSessionReady,
    readiness,
    restoredReadiness,
    routeQualified,
  ]);

  useEffect(() => {
    if (!autoRunNoSubmit) {
      autoRunNoSubmitConsumedRef.current = false;
      return;
    }
    if (!executionPair || !privateSessionReady || !routeQualified || autoRunNoSubmitConsumedRef.current) return;
    autoRunNoSubmitConsumedRef.current = true;
    onAutoRunNoSubmitStarted?.();
    void runCheck(true).then((outcome) => {
      if (outcome !== "blocked") onAutoRunNoSubmitResolved?.(outcome);
    });
  }, [autoRunNoSubmit, executionPair, onAutoRunNoSubmitResolved, onAutoRunNoSubmitStarted, privateSessionReady, routeQualified, runCheck]);

  async function savePosition() {
    if (!proof) return;
    const opportunity = asRecord(proof.creation_opportunity);
    const opportunityEvidenceCommitment = stringValue(
      asRecord(opportunity.worker_authentication).evidence_commitment,
    ) ?? "";
    const pilotVenue = stringValue(proof.qualification_pilot_candidate_venue_id);
    const pilot = proof.qualification_pilot_ready === true && isCarryExecutionVenue(pilotVenue)
      ? pilotVenue
      : null;
    if (proof.live_creation_ready !== true && !pilot) return;
    if (!/^carry:creation-opportunity:evidence:[0-9a-f]{64}$/.test(opportunityEvidenceCommitment)) {
      setMessage("CHECK INVALID · rerun the no-submit check before signing");
      return;
    }
    const notionalMicro = Math.round(Number(notional) * 1_000_000);
    if (!Number.isSafeInteger(notionalMicro) || notionalMicro <= 0) {
      setMessage("Enter a valid notional.");
      return;
    }
    const id = crypto.randomUUID();
    const positionId = `carry:position:${id}`;
    const mandateId = `carry:mandate:${id}`;
    const riskMandate = defaultCarryRiskMandate();
    const migrationCandidateId = migrationSource?.position.pending_migration?.selected_candidate?.candidate_id;
    const migrationLineage = migrationSource && migrationCandidateId ? {
      migration_parent_position_id: migrationSource.position.position_id,
      migration_candidate_id: migrationCandidateId,
    } : {};
    setBusy("save");
    setMessage(null);
    try {
      if (!perpsTurnkey.authenticated) throw new Error("carry_owner_auth_required");
      const [passportRaw, pair] = await Promise.all([
        getPrivateAgentPassport(),
        perpsTurnkey.ensureWalletPair(),
      ]);
      const passport = asRecord(passportRaw);
      const ownerCommitment = stringValue(passport.owner_commitment);
      if (!ownerCommitment) throw new Error("carry_owner_auth_required");
      const issuedAtMs = Date.now();
      const horizonDays = Math.max(1, Math.min(366, Math.ceil(Number(days) || 1)));
      const signedMandate = buildCarryRiskMandatePayload({
        network: "mainnet",
        owner_commitment: ownerCommitment,
        owner_wallet_address: pair.owner.address.toLowerCase() as `0x${string}`,
        position_id: positionId,
        mandate_id: mandateId,
        asset: candidate.asset,
        long_venue_id: candidate.long.venue_id,
        short_venue_id: candidate.short.venue_id,
        target_notional_micro_usdc: notionalMicro,
        opportunity_evidence_commitment: opportunityEvidenceCommitment,
        risk_mandate: riskMandate,
        ...migrationLineage,
        issued_at_ms: issuedAtMs,
        expires_at_ms: issuedAtMs + horizonDays * 86_400_000 + 3_600_000,
      });
      const signature = await perpsTurnkey.signCarryRiskMandate(signedMandate);
      const result = asRecord(await createCarryPosition({
        position_input: {
          version: 1,
          position_id: positionId,
          mandate_id: mandateId,
          asset: candidate.asset,
          long_venue_id: candidate.long.venue_id,
          short_venue_id: candidate.short.venue_id,
          target_notional_micro_usdc: notionalMicro,
          opportunity_evidence_commitment: opportunityEvidenceCommitment,
          risk_mandate: riskMandate,
          ...migrationLineage,
          mandate_authorization: carryRiskMandateAuthorization({ signed_mandate: signedMandate, signature }),
        },
        opportunity,
        ...(pilot ? { qualification_pilot: { enabled: true as const, candidate_venue_id: pilot } } : {}),
      }));
      if (result.ok !== true) throw new Error("carry_position_not_saved");
      setSaveSetupRequired(false);
      setMessage(migrationSource
        ? "MIGRATION SIGNED · parent is flat; replacement entry still requires the button below"
        : "OWNER-SIGNED · no order submitted; live paired entry requires the button below");
      await loadRecords();
    } catch (caught) {
      if (carryPositionSaveNeedsSetup(caught)) {
        setSaveSetupRequired(true);
        setMessage("SETUP REQUIRED · finish secure Carry access; no position or order was created");
      } else {
        setMessage("NOT SAVED · refresh the route and rerun the no-submit check");
      }
    } finally {
      setBusy(null);
    }
  }

  async function enterPosition(record: CarryRecord) {
    setBusy("enter");
    setMessage(null);
    try {
      const result = asRecord(await executeCarryPositionEntry(
        record.position.position_id,
        record.qualification_pilot?.enabled === true,
      ));
      if (result.ok !== true) throw new Error("carry_entry_failed");
      setMessage("OPEN · both legs reconciled; worker monitoring is active");
    } catch {
      setMessage("FROZEN · no ambiguity was retried; reconciliation remains active");
    } finally {
      await loadRecords();
      setBusy(null);
    }
  }

  async function exitPosition(record: CarryRecord) {
    setBusy("exit");
    setMessage(null);
    try {
      await requestCarryPositionExit({
        position_id: record.position.position_id,
        sequence: record.position.last_event_sequence + 1,
        event_id: `carry:owner-exit:${crypto.randomUUID()}`,
      });
      setMessage("EXIT REQUESTED · reduce-only recovery will finish only when flat with zero orders");
    } catch {
      setMessage("EXIT NOT ACCEPTED · refresh the position before retrying");
    } finally {
      await loadRecords();
      setBusy(null);
    }
  }

  async function approveCollateralReview() {
    if (collateralReview?.status !== "signature_required" || collateralApproval?.status === "owner_signature_verified") return;
    setBusy("approve");
    setMessage(null);
    try {
      const signature = await perpsTurnkey.signCarryCollateralReview(collateralReview);
      const result = asRecord(await approveCarryCollateralReview(
        buildCarryCollateralReviewAuthorization({
          signed_review: collateralReview,
          signature,
        }) as Record<string, unknown>,
      ));
      if (result.ok !== true) throw new Error(stringValue(result.error) || "carry_collateral_review_not_approved");
      setCollateralApproval(asRecord(result.receipt));
      setMessage("OWNER REVIEW RECORDED · NO FUNDS MOVED");
      await loadRecords();
    } catch {
      setMessage("REVIEW NOT RECORDED · REFRESH CAPITAL EVIDENCE");
    } finally {
      setBusy(null);
    }
  }

  const terminalReturn = `/trade?product=perps&venue=hyperliquid&market=${candidate.asset}-PERP&carry=open&long_venue=${encodeURIComponent(candidate.long.venue_id)}&short_venue=${encodeURIComponent(candidate.short.venue_id)}`;
  const noSubmitReturn = `${terminalReturn}&carry_check=no-submit`;
  const noSubmitSignInHref = `/signin?redirect=${encodeURIComponent(noSubmitReturn)}`;
  const pairSetupHref = `/account?setup=carry&long_venue=${encodeURIComponent(candidate.long.venue_id)}&short_venue=${encodeURIComponent(candidate.short.venue_id)}&return_to=${encodeURIComponent(terminalReturn)}`;
  const fleetSetupHref = `/account?setup=carry&return_to=${encodeURIComponent(terminalReturn)}`;
  const selectedPairReady = carryMatrixPairReady(
    executionMatrix,
    candidate.long.venue_id,
    candidate.short.venue_id,
  );
  const useFleetSetup = privateSessionReady && (restoredReadiness || selectedPairReady);
  const connectionHref = useFleetSetup ? fleetSetupHref : pairSetupHref;
  const canSave = routeQualified && actionableProof && creationProofFreshness.fresh;
  const needsSetupToSave = saveSetupRequired || !perpsTurnkey.authenticated;
  const canEnter = routeQualified && current?.position.status === "draft" && supervision.ready;
  const canExit = current ? ["active", "rebalancing", "frozen"].includes(current.position.status) : false;
  const connectionAction = auth.loading
    ? "CHECKING SIGN-IN…"
    : privateSessionReady
      ? restoredReadiness
        ? "MANAGE FLEET"
        : selectedPairReady
          ? "CONNECT FLEET"
          : "CONNECT PAIR"
      : model.netUsd == null
        ? "CONNECT TO VERIFY COSTS"
        : model.netUsd > 0
          ? "CONNECT TO VERIFY & TRADE"
          : "CONNECT TO VERIFY · NO EDGE YET";
  return (
    <div
      className="mt-2 grid gap-2 border-t border-[#1d2733] pt-2 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]"
      aria-label="Carry position builder"
      data-route-qualified={routeQualified ? "true" : "false"}
    >
      {!proof && !current ? (
        <div className="flex min-w-0 items-center justify-between gap-3 rounded border border-[#1d2733] bg-[#070a0f] px-2 py-1 lg:col-span-2">
          <span className="truncate font-mono text-[9px] font-semibold tracking-[0.12em] text-[#8fbbe2]">
            {routeQualified ? "SHADOW POSITION · LIVE-DATA MODEL" : "ROUTE RETAINED · ECONOMICS HIDDEN"}
          </span>
          <span className={`shrink-0 font-mono text-[9px] ${routeQualified ? "text-[#72bfa2]" : "text-[#d9bd74]"}`}>
            {routeQualified ? "NO WALLET · NO DEPOSIT · NO ORDER" : "STALE OR UNAVAILABLE · NO CHECK"}
          </span>
        </div>
      ) : null}
      <div className="grid gap-1.5 sm:grid-cols-4">
        <Metric label="ROUTE" value={`L ${venueName(candidate.long.venue_id)} / S ${venueName(candidate.short.venue_id)}`} />
        <Metric label={proof ? "GROSS" : "GROSS EST"} value={grossFunding.value} tone={grossFunding.tone} />
        <Metric label="FEES" value={economics.fees} />
        <Metric label="SLIPPAGE" value={economics.slippage} tone={economics.depthTone} />
        <Metric label="USABLE DEPTH" value={economics.depth} tone={economics.depthTone} />
        <Metric label={`NET / ${days}D`} value={economics.net} tone={economics.netTone} />
        <Metric label="BREAK-EVEN" value={economics.breakEven} />
        <Metric label={proof ? "VENUE MIN MARGIN" : "VENUE MIN MARGIN EST"} value={venueMinimumMargin.value} tone={venueMinimumMargin.tone} />
        <Metric label="LEG RUNWAY" value={runway.value} tone={runway.tone} />
        {portfolioRunway ? <Metric label="PORTFOLIO RUNWAY" value={portfolioRunway.value} tone={portfolioRunway.tone} /> : null}
        <Metric label="CARRY SIGNAL" value={carrySignal.value} tone={carrySignal.tone} />
        <Metric label="OWNER CAPITAL" value={displayedCapital.value} tone={displayedCapital.tone} />
        <Metric label="COLLATERAL" value={collateralBasis.value} tone={collateralBasis.tone} />
        <Metric label="LIQUIDATION" value={liquidation.value} tone={liquidation.tone} />
        <Metric label="LEDGER" value={ledger.value} tone={ledger.tone} />
        <Metric label="EXEC Δ" value={ledger.execution} tone={ledger.executionTone} />
        <Metric
          label="SOURCE SYNC"
          value={routeQualified
            ? `${formatSkew(proofOpportunity?.contract_data_skew_ms ?? model.contractDataSkewMs)}${proofOpportunity ? "" : " · EST"}`
            : "STALE"}
          tone={routeQualified && model.contractsComparable ? "good" : routeQualified ? "bad" : "warn"}
        />
        <Metric
          label="INDEX BASIS"
          value={routeQualified
            ? `${formatBasis(proofOpportunity?.index_price_divergence_bps ?? model.indexPriceDivergenceBps)}${proofOpportunity ? "" : " · EST"}`
            : "STALE"}
          tone={routeQualified && model.contractsComparable ? "good" : routeQualified ? "bad" : "warn"}
        />
        <Metric label="EDGE CONF" value={fundingPersistence.value} tone={fundingPersistence.tone} />
        <Metric label="PRIVATE PRIME" value={privatePrime.value} tone={privatePrime.tone} />
        <Metric label="RISK MANDATE" value={mandate.value} tone={mandate.tone} />
        <Metric label="RISK ENGINE" value={supervision.value} tone={supervision.tone} />
        <Metric label="MONITOR" value={monitorAge(latestObservation?.recorded_at_ms)} />
      </div>

      <div className="grid gap-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <label className="rounded border border-[#202a37] bg-[#070a0f] px-2 py-1 font-mono text-[9px] text-[#687589]">
            NOTIONAL / LEG
            <span className="mt-0.5 flex items-center text-[11px] text-[#d7dde6]">$<input aria-label="Carry notional per leg" value={notional} readOnly={Boolean(migrationSource)} onChange={(event) => invalidateProof(setNotional)(event.target.value)} inputMode="decimal" className="min-w-0 flex-1 bg-transparent pl-1 outline-none" /></span>
          </label>
          <label className="rounded border border-[#202a37] bg-[#070a0f] px-2 py-1 font-mono text-[9px] text-[#687589]">
            HORIZON
            <span className="mt-0.5 flex items-center text-[11px] text-[#d7dde6]"><input aria-label="Carry horizon in days" value={days} onChange={(event) => invalidateProof(setDays)(event.target.value)} inputMode="numeric" className="min-w-0 flex-1 bg-transparent outline-none" />D</span>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <Link href={connectionHref} className={`rounded border border-[#293a50] px-2 py-2 text-center font-mono text-[10px] font-semibold text-[#8fbbe2] hover:bg-[#0d1622] ${privateSessionReady ? "" : "col-span-2"}`}>
            {connectionAction}
          </Link>
          {noSubmitAuthRequired ? (
            <Link href={noSubmitSignInHref} className="rounded border border-[#63333b] bg-[#231014] px-2 py-2 text-center font-mono text-[10px] font-semibold text-[#ffc2c7] hover:bg-[#2b151a]">
              SIGN IN AGAIN · NO ORDER SUBMITTED
            </Link>
          ) : !privateSessionReady ? null : !recordsLoaded ? (
            <button type="button" disabled={recordsLoading} onClick={() => void loadRecords()} className="rounded border border-[#594b2b] bg-[#1e190c] px-2 py-2 font-mono text-[10px] font-semibold text-[#d9bd74] disabled:opacity-40">
              {recordsLoading ? "SYNCING POSITIONS…" : "RETRY POSITION SYNC"}
            </button>
          ) : !current && !canSave ? (
            <button type="button" disabled={!executionPair || !routeQualified || busy !== null} onClick={() => void runCheck()} className="rounded border border-[#285040] bg-[#0a1b16] px-2 py-2 font-mono text-[10px] font-semibold text-[#75d9b0] disabled:opacity-40">
              {busy === "check" ? "CHECKING…" : !routeQualified ? "ROUTE STALE · WAITING" : executionPair ? restoredReadiness ? "CHECK PAIR · FLEET READY" : "NO-SUBMIT CHECK" : "READ-ONLY ROUTE"}
            </button>
          ) : !current && canSave && needsSetupToSave ? (
            <Link href={pairSetupHref} className="rounded border border-[#31577a] bg-[#10243a] px-2 py-2 text-center font-mono text-[10px] font-semibold text-[#b7ddff] hover:bg-[#142c46]">
              FINISH CARRY SETUP
            </Link>
          ) : !current && canSave ? (
            <button type="button" disabled={busy !== null} onClick={() => void savePosition()} className="rounded border border-[#31577a] bg-[#10243a] px-2 py-2 font-mono text-[10px] font-semibold text-[#b7ddff] disabled:opacity-40">
              {busy === "save" ? "SAVING…" : migrationSource ? "SIGN MIGRATION" : proof?.qualification_pilot_ready === true ? "ARM CAPPED PROOF" : "SAVE POSITION"}
            </button>
          ) : current?.position.status === "draft" && !routeQualified ? (
            <button type="button" disabled className="rounded border border-[#594b2b] bg-[#1e190c] px-2 py-2 font-mono text-[10px] font-semibold text-[#d9bd74] opacity-70">
              ROUTE STALE · ENTRY LOCKED
            </button>
          ) : current?.position.status === "draft" && !supervision.ready ? (
            <button type="button" disabled className="rounded border border-[#63333b] bg-[#231014] px-2 py-2 font-mono text-[10px] font-semibold text-[#ef929e] opacity-70">
              RISK ENGINE NOT READY
            </button>
          ) : canEnter && current ? (
            <button type="button" disabled={busy !== null} onClick={() => void enterPosition(current)} className="rounded border border-[#6b4d25] bg-[#24190b] px-2 py-2 font-mono text-[10px] font-semibold text-[#f0c879] disabled:opacity-40">
              {busy === "enter" ? "SUBMITTING…" : "CONFIRM LIVE PAIRED ENTRY"}
            </button>
          ) : canExit && current ? (
            <button type="button" disabled={busy !== null} onClick={() => void exitPosition(current)} className="rounded border border-[#63333b] bg-[#231014] px-2 py-2 font-mono text-[10px] font-semibold text-[#ef929e] disabled:opacity-40">
              {busy === "exit" ? "REQUESTING…" : "REDUCE-ONLY EXIT"}
            </button>
          ) : (
            <button type="button" disabled className="rounded border border-[#202a37] px-2 py-2 font-mono text-[10px] text-[#697587]">
              {current?.position.status.toUpperCase() || "POSITION READY"}
            </button>
          )}
        </div>
        {message
          ? <p role="status" className="truncate font-mono text-[9px] text-[#8996a8]">{message}</p>
          : lastCheckReceipt
            ? <p role="status" className="truncate font-mono text-[9px] text-[#8996a8]">NO-SUBMIT RECEIPT · {lastCheckReceipt}</p>
          : lastFlat
            ? <p role="status" className="truncate font-mono text-[9px] text-[#72bfa2]">LAST FLAT · 0 ORDERS</p>
            : null}
        {stressCapital
          ? <p className="truncate font-mono text-[9px] text-[#72bfa2]" title={stressCapital}>STRESS CAPITAL · {stressCapital}</p>
          : null}
        <p className={`truncate font-mono text-[9px] ${privatePrime.tone === "good" ? "text-[#72bfa2]" : privatePrime.tone === "bad" ? "text-[#ef929e]" : "text-[#d9bd74]"}`} title={privatePrime.detail}>PRIVATE PRIME · {privatePrime.detail}</p>
        <p className={`truncate font-mono text-[9px] ${fleetGuard.tone === "good" ? "text-[#72bfa2]" : fleetGuard.tone === "bad" ? "text-[#ef929e]" : "text-[#8996a8]"}`} title={fleetGuard.value}>FLEET · {fleetGuard.value}</p>
        {portfolioCapital
          ? <p className={`truncate font-mono text-[9px] ${portfolioCapital.tone === "bad" ? "text-[#ef929e]" : portfolioCapital.tone === "warn" ? "text-[#d9bd74]" : "text-[#72bfa2]"}`} title={portfolioCapital.value}>PORTFOLIO CAPITAL · {portfolioCapital.value}</p>
          : null}
        {collateral
          ? <div className="flex min-w-0 items-center gap-2">
              <p className={`min-w-0 flex-1 truncate font-mono text-[9px] ${collateral.tone === "bad" ? "text-[#ef929e]" : collateral.tone === "warn" ? "text-[#d9bd74]" : "text-[#72bfa2]"}`} title={collateral.value}>COLLATERAL REVIEW · {collateral.value}</p>
              {collateralOutcome?.capital_outcome_verified === true
                ? <span className="shrink-0 font-mono text-[8px] font-semibold text-[#72bfa2]">SAFE RUNWAY VERIFIED · NO FUNDS MOVED</span>
                : collateralApproval?.status === "owner_signature_verified"
                  ? <span className="shrink-0 font-mono text-[8px] font-semibold text-[#d9bd74]">OWNER VERIFIED · NO FUNDS MOVED · MONITORING</span>
                : collateralReview?.status === "signature_required"
                ? <button type="button" disabled={busy !== null || !perpsTurnkey.authenticated} onClick={() => void approveCollateralReview()} className="shrink-0 rounded border border-[#594b2b] px-1.5 py-0.5 font-mono text-[8px] font-semibold text-[#d9bd74] disabled:opacity-40">{busy === "approve" ? "SIGNING…" : "SIGN CAPITAL REVIEW"}</button>
                : null}
            </div>
          : null}
        {portfolioValue
          ? <p className={`truncate font-mono text-[9px] ${portfolioValue.tone === "bad" ? "text-[#ef929e]" : portfolioValue.tone === "warn" ? "text-[#d9bd74]" : "text-[#72bfa2]"}`} title={portfolioValue.value}>PORTFOLIO VALUE · {portfolioValue.value}</p>
          : null}
        {capitalEfficiency
          ? <p className={`truncate font-mono text-[9px] ${capitalEfficiency.tone === "bad" ? "text-[#ef929e]" : capitalEfficiency.tone === "warn" ? "text-[#d9bd74]" : "text-[#72bfa2]"}`} title={capitalEfficiency.value}>CAPITAL OFFSET · {capitalEfficiency.value}</p>
          : null}
      </div>
    </div>
  );
});

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  const color = tone === "good" ? "text-[#72dfb2]" : tone === "warn" ? "text-[#d9bd74]" : tone === "bad" ? "text-[#ef929e]" : "text-[#c8d0dc]";
  return <div className="rounded border border-[#1d2733] bg-[#070a0f] px-2 py-1"><p className="font-mono text-[9px] text-[#5f6c7e]">{label}</p><p title={value} className={`mt-0.5 truncate font-mono text-[10px] ${color}`}>{value}</p></div>;
}

export function carryTerminalEconomics(model: ReturnType<typeof builderModel>, opportunity: Record<string, unknown> | null) {
  const proofFee = microUsdValue(opportunity?.projected_trading_fee_micro_usdc);
  const proofSlippage = microUsdValue(opportunity?.projected_slippage_micro_usdc);
  const proofNet = microUsdValue(opportunity?.projected_net_value_micro_usdc);
  const proofBreakEvenMs = finiteNumber(opportunity?.break_even_ms);
  const depth = opportunity ? proofDepth(opportunity) : {
    status: model.depthStatus,
    minimumUsd: model.minimumDisplayedDepthUsd,
  };
  const netUsd = opportunity ? proofNet : model.netUsd;
  return {
    fees: opportunity ? formatVerifiedEconomicUsd(proofFee) : formatEconomicUsd(model.tradingFeeUsd),
    slippage: depth.status === "sufficient"
      ? opportunity ? formatVerifiedEconomicUsd(proofSlippage) : formatEconomicUsd(model.slippageUsd)
      : depth.status === "insufficient" ? "DEPTH LIMITED" : "UNVERIFIED",
    depth: depth.status === "sufficient" && depth.minimumUsd != null
      ? `${formatUsd(depth.minimumUsd)} MIN`
      : depth.status.toUpperCase(),
    depthTone: depth.status === "sufficient" ? "good" as const : depth.status === "insufficient" ? "bad" as const : "warn" as const,
    net: opportunity ? formatVerifiedEconomicUsd(netUsd) : formatEconomicUsd(netUsd),
    netTone: netUsd != null && netUsd > 0 ? "good" as const : undefined,
    breakEven: opportunity
      ? proofBreakEvenMs == null ? "UNVERIFIED" : `${(proofBreakEvenMs / 86_400_000).toFixed(1)}D`
      : model.breakEvenDays == null ? "—" : `${model.breakEvenDays.toFixed(1)}D`,
  };
}

export function carryRiskMandateSummary(mandate: ReturnType<typeof defaultCarryRiskMandate>) {
  const exitBps = finiteNumber(mandate.exit_net_value_bps);
  const flipCount = finiteNumber(mandate.exit_after_consecutive_observations);
  const runwayMs = finiteNumber(mandate.min_margin_runway_ms);
  const ownerOnly = mandate.owner_only_operations;
  if (!Number.isSafeInteger(exitBps)
    || !Number.isSafeInteger(flipCount)
    || Number(flipCount) < 1
    || !Number.isSafeInteger(runwayMs)
    || Number(runwayMs) <= 0
    || !(["fund", "transfer", "withdraw"] as const).every((operation) => ownerOnly.includes(operation))) {
    return { value: "UNVERIFIED", tone: "bad" as const };
  }
  const exit = Number(exitBps) < 0 ? `−${Math.abs(Number(exitBps))}` : String(Number(exitBps));
  return {
    value: `EXIT ≤${exit}BP · ${flipCount} FLIPS · ≥${formatRunway(Number(runwayMs))} · OWNER MOVES`,
    tone: "good" as const,
  };
}

export function carryCreationProofFreshness(
  opportunity: Record<string, unknown> | null,
  nowMs = Date.now(),
) {
  const checkedAtMs = finiteNumber(opportunity?.checked_at_ms);
  if (!Number.isSafeInteger(checkedAtMs)
    || Number(checkedAtMs) <= 0
    || Number(checkedAtMs) > nowMs + CARRY_CREATION_PROOF_FUTURE_TOLERANCE_MS) {
    return { fresh: false, expires_at_ms: null } as const;
  }
  const expiresAtMs = Number(checkedAtMs) + CARRY_CREATION_PROOF_MAX_AGE_MS;
  return {
    fresh: nowMs <= expiresAtMs,
    expires_at_ms: expiresAtMs,
  } as const;
}

export function carryCollateralBasisSummary(
  candidate: CarryCandidate,
  opportunity: Record<string, unknown> | null,
) {
  const longAsset = stringValue(opportunity?.long_collateral_asset) || candidate.long.collateral_asset || null;
  const shortAsset = stringValue(opportunity?.short_collateral_asset) || candidate.short.collateral_asset || null;
  if (!longAsset || !shortAsset) return { value: "UNVERIFIED", tone: "bad" as const };
  if (!opportunity) {
    return longAsset === shortAsset
      ? { value: `${longAsset}/${shortAsset} · SAME`, tone: "good" as const }
      : { value: `${longAsset}/${shortAsset} · BASIS EST`, tone: "warn" as const };
  }
  const riskUsd = microUsdValue(opportunity.collateral_basis_risk_micro_usdc);
  if (riskUsd === null
    || (longAsset === shortAsset && riskUsd !== 0)
    || (longAsset !== shortAsset && riskUsd <= 0)) {
    return { value: "UNVERIFIED", tone: "bad" as const };
  }
  return riskUsd === 0
    ? { value: `${longAsset}/${shortAsset} · SAME`, tone: "good" as const }
    : { value: `${longAsset}/${shortAsset} · ${formatUsd(riskUsd)} STRESS`, tone: "warn" as const };
}

export function carryLiquidationSummary(candidate: CarryCandidate) {
  const legs = [candidate.long, candidate.short];
  const values = legs.map((leg) => finiteNumber(leg.liquidation_fee_bps));
  const models = legs.map((leg) => stringValue(leg.liquidation_model));
  if (values.some((value) => value == null || value < 0)
    || models.some((model) => !model || model === "unavailable")) {
    return { value: "UNVERIFIED", tone: "bad" as const };
  }
  return {
    value: legs.map((leg, index) => `${runwayVenueCode(leg.venue_id)} ${formatBasis(values[index])}`).join(" · "),
    tone: undefined,
  };
}

export function carryTerminalGrossFunding(
  candidate: CarryCandidate,
  opportunity: Record<string, unknown> | null,
) {
  if (!opportunity) {
    const grossBpsPerDay = candidate.grossAnnualBps / 365;
    return {
      value: `${formatSigned(grossBpsPerDay)} BP/D`,
      tone: grossBpsPerDay > 0 ? "good" as const : undefined,
    };
  }
  const grossFundingMicro = finiteNumber(opportunity.projected_gross_funding_micro_usdc);
  const notionalMicro = finiteNumber(opportunity.notional_micro_usdc);
  const horizonMs = finiteNumber(opportunity.horizon_ms);
  if (!Number.isSafeInteger(grossFundingMicro)
    || !Number.isSafeInteger(notionalMicro)
    || !Number.isSafeInteger(horizonMs)
    || Number(notionalMicro) <= 0
    || Number(horizonMs) <= 0) return { value: "UNVERIFIED", tone: "bad" as const };
  const grossBpsPerDay = Number(grossFundingMicro)
    / Number(notionalMicro)
    * 10_000
    * 86_400_000
    / Number(horizonMs);
  if (!Number.isFinite(grossBpsPerDay)) return { value: "UNVERIFIED", tone: "bad" as const };
  return {
    value: `${formatSigned(grossBpsPerDay)} BP/D`,
    tone: grossBpsPerDay > 0 ? "good" as const : undefined,
  };
}

export function carryFundingPersistenceSummary(opportunity: Record<string, unknown> | null) {
  if (!opportunity) return { value: "PENDING", tone: undefined, ready: false } as const;
  const persistence = asRecord(opportunity.funding_persistence);
  const reasons = Array.isArray(persistence.reasons)
    ? persistence.reasons.filter((value): value is string => typeof value === "string")
    : [];
  const sampleCount = finiteNumber(persistence.sample_count);
  const minimumSamples = finiteNumber(persistence.minimum_samples);
  const spanMs = finiteNumber(persistence.observed_span_ms);
  const minimumSpanMs = finiteNumber(persistence.minimum_span_ms);
  const spread = finiteNumber(persistence.conservative_hourly_spread_e12);
  const commitment = stringValue(persistence.evidence_commitment);
  if (persistence.version !== 1
    || !Number.isSafeInteger(sampleCount)
    || !Number.isSafeInteger(minimumSamples)
    || !Number.isSafeInteger(spanMs)
    || !Number.isSafeInteger(minimumSpanMs)
    || Number(sampleCount) < 1
    || Number(minimumSamples) < 1
    || Number(spanMs) < 0
    || Number(minimumSpanMs) < 0) {
    return { value: "UNVERIFIED", tone: "bad", ready: false } as const;
  }
  if (persistence.ready === true) {
    const valid = reasons.length === 0
      && Number(sampleCount) >= Number(minimumSamples)
      && Number(spanMs) >= Number(minimumSpanMs)
      && spread != null
      && spread > 0
      && /^carry:funding:[a-f0-9]{64}$/.test(commitment || "");
    return valid
      ? { value: `${sampleCount}/${minimumSamples} · ${formatRunway(Number(spanMs))} · DURABLE`, tone: "good", ready: true } as const
      : { value: "UNVERIFIED", tone: "bad", ready: false } as const;
  }
  if (reasons.includes("funding_persistence_evidence_invalid")) {
    return { value: "EVIDENCE INVALID", tone: "bad", ready: false } as const;
  }
  if (reasons.includes("funding_persistence_state_unavailable")) {
    return { value: "HISTORY UNAVAILABLE", tone: "bad", ready: false } as const;
  }
  if (reasons.includes("funding_not_persistent")) {
    return { value: "NO DURABLE EDGE", tone: "bad", ready: false } as const;
  }
  return {
    value: `${sampleCount}/${minimumSamples} · ${formatRunway(Number(spanMs))} OBSERVED`,
    tone: "warn",
    ready: false,
  } as const;
}

export function carryVenueMinimumMarginSummary(
  model: ReturnType<typeof builderModel>,
  proof: Record<string, unknown> | null,
) {
  const accounts = Array.isArray(proof?.account_readiness)
    ? proof.account_readiness.map(asRecord)
    : [];
  if (accounts.length === 2) {
    const margins = accounts.map((item) => finiteNumber(item.venue_minimum_margin_micro_usdc));
    if (margins.some((value) => !Number.isSafeInteger(value) || Number(value) < 0)) {
      return { value: "UNVERIFIED", tone: "bad" as const };
    }
    const exactMargins = margins.filter((value): value is number => value != null);
    return {
      value: formatMicroUsd(exactMargins.reduce((sum, value) => sum + value, 0)),
      tone: undefined,
    };
  }
  if (proof) return { value: "UNVERIFIED", tone: "bad" as const };
  return { value: formatUsd(model.minimumCollateralUsd), tone: undefined };
}

export function carryOpeningCapitalSummary(
  model: ReturnType<typeof builderModel>,
  proof: Record<string, unknown> | null,
) {
  const accounts = Array.isArray(proof?.account_readiness)
    ? proof.account_readiness.map(asRecord)
    : [];
  if (accounts.length === 2) {
    const shortfalls = accounts.map((item) => finiteNumber(item.opening_collateral_shortfall_micro_usdc));
    if (shortfalls.some((value) => value == null)) return { value: "UNVERIFIED", tone: "bad" as const };
    const totalShortfallUsd = shortfalls
      .filter((value): value is number => value != null)
      .reduce((sum, value) => sum + value, 0) / 1_000_000;
    if (totalShortfallUsd > 0) {
      const actions = accounts.flatMap((item, index) => {
        const shortfall = shortfalls[index];
        const venueId = stringValue(item.venue_id);
        return shortfall != null && shortfall > 0 && venueId
          ? [`${venueName(venueId)} ${formatUsd(shortfall / 1_000_000)}`]
          : [];
      });
      return {
        value: `${actions.join(" · ")} · OWNER`,
        tone: "warn" as const,
      };
    }
    return { value: "READY · 1×", tone: "good" as const };
  }
  if (proof) return { value: "UNVERIFIED", tone: "bad" as const };
  return {
    value: `${formatUsd(model.requiredOpeningCapitalUsd)} TOTAL · 1×`,
    tone: undefined,
  };
}

function carryStressCapitalSummary(proof: Record<string, unknown> | null) {
  const plan = asRecord(proof?.opening_capital_plan);
  if (plan.proposal_only !== true
    || plan.live_execution_leverage_unchanged !== true
    || plan.owner_only_funding !== true
    || plan.automatic_transfer_permitted !== false
    || plan.transaction_broadcast !== false) return null;
  const required = finiteNumber(plan.total_required_opening_collateral_micro_usdc);
  const target = finiteNumber(plan.total_stress_adjusted_target_collateral_micro_usdc);
  const potential = finiteNumber(plan.total_potential_releasable_collateral_micro_usdc);
  const legs = Array.isArray(plan.legs) ? plan.legs.map(asRecord) : [];
  const leverage = legs.map((leg) => finiteNumber(leg.owner_maximum_stress_adjusted_leverage));
  if (required == null || target == null || potential == null
    || required <= 0 || target <= 0 || target > required
    || potential !== required - target
    || legs.length !== 2 || leverage.some((value) => value == null || value < 1)) return null;
  const ownerMaximum = Math.min(...leverage.filter((value): value is number => value != null));
  return `${formatMicroUsd(target)} TARGET / ${formatMicroUsd(required)} 1× · UP TO ${ownerMaximum}× OWNER CONFIG · ${formatMicroUsd(potential)} POTENTIAL`;
}

function carryPortfolioCapitalSummary(plan: Record<string, unknown> | null) {
  if (!plan) return null;
  const ownerOnlyOperations = Array.isArray(plan.owner_only_operations) ? plan.owner_only_operations : [];
  if (plan.error === "carry_portfolio_capital_evidence_incomplete"
    && plan.proposal_only === true
    && plan.transaction_broadcast === false
    && plan.automatic_transfer_permitted === false) {
    const missing = Array.isArray(plan.missing_position_ids) ? plan.missing_position_ids.length : 0;
    return missing > 0 ? { value: `${missing} POSITION${missing === 1 ? "" : "S"} NEED FRESH MONITORING`, tone: "bad" as const } : null;
  }
  if (plan.kind !== "ghola_carry_portfolio_capital_plan"
    || plan.proposal_only !== true
    || plan.transaction_broadcast !== false
    || plan.automatic_transfer_permitted !== false
    || !["fund", "transfer", "withdraw"].every((operation) => ownerOnlyOperations.includes(operation))) return null;
  const positions = finiteNumber(plan.position_count);
  const requested = finiteNumber(plan.total_requested_micro_usdc);
  const potentialReleasable = finiteNumber(plan.total_potential_releasable_micro_usdc);
  const internalReallocation = finiteNumber(plan.total_proposed_internal_reallocation_micro_usdc);
  const netNewOwnerCapital = finiteNumber(plan.net_new_owner_capital_requested_micro_usdc);
  const proposedOwnerCapital = finiteNumber(plan.total_proposed_allocation_micro_usdc);
  const uncovered = finiteNumber(plan.total_uncovered_shortfall_micro_usdc);
  if (positions == null || requested == null || potentialReleasable == null || internalReallocation == null
    || netNewOwnerCapital == null || proposedOwnerCapital == null || uncovered == null
    || positions < 0 || requested < 0 || potentialReleasable < 0 || internalReallocation < 0
    || netNewOwnerCapital < 0 || proposedOwnerCapital < 0 || uncovered < 0
    || internalReallocation > potentialReleasable
    || requested !== internalReallocation + netNewOwnerCapital
    || netNewOwnerCapital !== proposedOwnerCapital + uncovered) return null;
  if (positions === 0) return null;
  if (plan.status === "quarantined") return { value: "STALE EVIDENCE · RECONCILE ONLY", tone: "bad" as const };
  if (plan.status === "exit_required") return { value: "EXIT PRIORITY · REDUCE ONLY", tone: "bad" as const };
  if (plan.status === "owner_action_required") {
    return {
      value: internalReallocation > 0
        ? `${formatMicroUsd(internalReallocation)} REALLOCATE · ${formatMicroUsd(netNewOwnerCapital)} NEW CASH · OWNER ONLY`
        : `${formatMicroUsd(netNewOwnerCapital)} NEW CASH · ${formatMicroUsd(uncovered)} UNFUNDED · OWNER ONLY`,
      tone: "warn" as const,
    };
  }
  if (plan.capital_optimization_available === true && potentialReleasable > 0) {
    return { value: `${formatMicroUsd(potentialReleasable)} RELEASABLE · OWNER ONLY`, tone: "good" as const };
  }
  return { value: `${positions} POSITION${positions === 1 ? "" : "S"} · BALANCED`, tone: "good" as const };
}

export function carryPortfolioRunwaySummary(plan: Record<string, unknown> | null) {
  if (!plan) return null;
  const positions = finiteNumber(plan.position_count);
  if (positions === 0) return null;
  if (!Number.isSafeInteger(positions) || Number(positions) < 0
    || plan.kind !== "ghola_carry_portfolio_capital_plan"
    || plan.proposal_only !== true
    || plan.transaction_broadcast !== false
    || plan.automatic_transfer_permitted !== false) {
    return { value: "UNVERIFIED", tone: "bad" as const };
  }
  const accounts = Array.isArray(plan.accounts) ? plan.accounts.map(asRecord) : [];
  if (accounts.length === 0) return { value: "UNVERIFIED", tone: "bad" as const };
  const normalized = accounts.map((account) => {
    const venueId = stringValue(account.venue_id);
    const runway = account.aggregate_runway_ms;
    const burn = account.aggregate_stress_burn_micro_usdc_per_hour;
    const target = account.target_runway_ms;
    if (!venueId || !Number.isSafeInteger(burn) || Number(burn) < 0
      || !Number.isSafeInteger(target) || Number(target) < 0
      || (Number(burn) === 0 && runway !== null)
      || (Number(burn) > 0 && (!Number.isSafeInteger(runway) || Number(runway) < 0))) return null;
    return {
      venueId,
      runway: runway === null ? null : Number(runway),
      target: Number(target),
      risk: account.risk_action_required === true,
    };
  });
  if (normalized.some((account) => account === null)) return { value: "UNVERIFIED", tone: "bad" as const };
  const verified = normalized.filter((account): account is NonNullable<typeof account> => account !== null);
  const worst = [...verified].sort((left, right) => {
    const leftRunway = left.runway ?? Number.MAX_SAFE_INTEGER;
    const rightRunway = right.runway ?? Number.MAX_SAFE_INTEGER;
    return leftRunway - rightRunway || left.venueId.localeCompare(right.venueId);
  })[0];
  const unsafe = worst.risk || (worst.runway !== null && worst.runway < worst.target);
  const warning = plan.status === "owner_action_required";
  return {
    value: `${runwayVenueCode(worst.venueId)} ${worst.runway === null ? "∞" : formatRunway(worst.runway)} · ${accounts.length} ACCT${accounts.length === 1 ? "" : "S"}`,
    tone: unsafe || ["quarantined", "exit_required"].includes(String(plan.status))
      ? "bad" as const
      : warning ? "warn" as const : "good" as const,
  };
}

function carryCollateralReviewSummary(review: Record<string, unknown> | null) {
  if (!review) return null;
  if (review.error === "carry_portfolio_capital_evidence_incomplete"
    && review.proposal_only === true
    && review.review_only === true
    && review.execution_authorized === false
    && review.transaction_broadcast === false
    && review.automatic_transfer_permitted === false) {
    return { value: "AWAITING FRESH MONITORING", tone: "bad" as const };
  }
  if (review.kind !== "ghola_carry_collateral_review"
    || review.proposal_only !== true
    || review.review_only !== true
    || review.execution_authorized !== false
    || review.fund_movement_authorized !== false
    || review.transaction_broadcast !== false
    || review.automatic_transfer_permitted !== false
    || review.withdrawal_permitted !== false
    || review.trade_permitted !== false) return null;
  const transfers = Array.isArray(review.transfer_instructions) ? review.transfer_instructions.map(asRecord) : [];
  const funding = Array.isArray(review.funding_instructions) ? review.funding_instructions.map(asRecord) : [];
  const valid = [...transfers, ...funding].every((instruction) => instruction.owner_signature_required === true
    && instruction.execution_authorized === false
    && instruction.transaction_broadcast === false
    && Number.isSafeInteger(instruction.amount_micro_usdc)
    && Number(instruction.amount_micro_usdc) > 0);
  if (!valid) return null;
  if (review.status === "blocked") return { value: "BLOCKED · RECONCILE OR EXIT FIRST", tone: "bad" as const };
  if (review.status === "no_action") return { value: "NO MOVE NEEDED", tone: "good" as const };
  if (review.status !== "signature_required" || review.owner_signature_required !== true) return null;
  const total = [...transfers, ...funding].reduce((sum, instruction) => sum + Number(instruction.amount_micro_usdc), 0);
  return {
    value: `${transfers.length} MOVE${transfers.length === 1 ? "" : "S"} · ${funding.length} FUND · ${formatMicroUsd(total)} · REVIEW ONLY`,
    tone: "warn" as const,
  };
}

export function carryPortfolioValueSummary(report: Record<string, unknown> | null) {
  if (!report) return null;
  const ownerOnlyOperations = Array.isArray(report.owner_only_operations) ? report.owner_only_operations : [];
  if (report.kind !== "ghola_carry_portfolio_value_report"
    || report.proposal_only !== true
    || report.transaction_broadcast !== false
    || report.automatic_transfer_permitted !== false
    || !["fund", "transfer", "withdraw"].every((operation) => ownerOnlyOperations.includes(operation))) return null;
  const positions = finiteNumber(report.position_count);
  const open = finiteNumber(report.open_position_count);
  const finalized = finiteNumber(report.finalized_position_count);
  const authoritativeFinalized = finiteNumber(report.authoritative_finalized_position_count);
  const modeled = finiteNumber(asRecord(report.modeled).net_value_micro_usdc);
  const finalizedValues = asRecord(report.finalized_after_costs);
  const realized = finiteNumber(finalizedValues.net_value_micro_usdc);
  const variance = finiteNumber(finalizedValues.variance_from_modeled_micro_usdc);
  const openModeled = finiteNumber(asRecord(report.unfinalized).modeled_net_value_micro_usdc);
  if (![positions, open, finalized, modeled, realized, variance, openModeled].every((value) => value != null)
    || positions == null || open == null || finalized == null || modeled == null || realized == null || variance == null || openModeled == null
    || ![positions, open, finalized, modeled, realized, variance, openModeled].every(Number.isSafeInteger)
    || positions < 0 || open < 0 || finalized < 0 || open + finalized !== positions) return null;
  if (positions === 0) return null;
  if (report.valuation_asset !== "USDC"
    || report.funding_valuation_basis !== "usdc_equivalent_at_ledger_ingestion") {
    return { value: "UNVERIFIED FX BASIS", tone: "bad" as const };
  }
  const expectedStatus = finalized === positions ? "finalized" : finalized > 0 ? "mixed" : "accruing";
  if (finalized > 0) {
    if (report.value_proof_status !== expectedStatus
      || !Number.isSafeInteger(authoritativeFinalized)
      || authoritativeFinalized !== finalized
      || report.finalized_value_provenance !== "authoritative_exchange_fill_time"
      || report.real_value_verified !== true
      || finalizedValues.complete !== true) {
      return { value: "UNVERIFIED", tone: "bad" as const };
    }
    return {
      value: open > 0
        ? `${formatMicroUsd(realized)} REAL · ${formatMicroUsd(openModeled)} OPEN MODEL · ${formatSignedMicroUsd(variance)} Δ · USDC @ BOOKED FX`
        : `${formatMicroUsd(realized)} REAL · ${formatSignedMicroUsd(variance)} Δ · ALL COSTS · USDC @ BOOKED FX`,
      tone: realized >= 0 ? "good" as const : "bad" as const,
    };
  }
  if (report.value_proof_status !== expectedStatus) return null;
  return { value: `${formatMicroUsd(modeled)} MODEL · ACCRUING · USDC`, tone: "warn" as const };
}

export function carryCapitalEfficiencySummary(report: Record<string, unknown> | null) {
  if (!report) return null;
  const positions = finiteNumber(report.position_count);
  if (!Number.isSafeInteger(positions) || Number(positions) < 0) {
    return { value: "UNVERIFIED", tone: "bad" as const };
  }
  if (Number(positions) === 0) return null;
  const ownerOnlyOperations = Array.isArray(report.owner_only_operations) ? report.owner_only_operations : [];
  if (report.kind !== "ghola_carry_portfolio_value_report"
    || report.proposal_only !== true
    || report.transaction_broadcast !== false
    || report.automatic_transfer_permitted !== false
    || !["fund", "transfer", "withdraw"].every((operation) => ownerOnlyOperations.includes(operation))) {
    return { value: "UNVERIFIED", tone: "bad" as const };
  }
  const capital = asRecord(report.capital_efficiency);
  if (capital.proposal_only !== true) return { value: "UNVERIFIED", tone: "bad" as const };
  if (capital.status === "incomplete") {
    const missing = Array.isArray(capital.missing_position_ids)
      ? capital.missing_position_ids.filter((value) => typeof value === "string" && value.length > 0)
      : [];
    const emptyValues = [
      capital.potential_releasable_micro_usdc,
      capital.proposed_reallocation_micro_usdc,
      capital.potential_new_cash_avoided_micro_usdc,
      capital.new_owner_cash_requested_micro_usdc,
      capital.uncovered_shortfall_micro_usdc,
    ].every((value) => value === null);
    return missing.length > 0 && emptyValues && capital.owner_approval_required === false
      ? { value: `${missing.length} POSITION${missing.length === 1 ? "" : "S"} NEED FRESH MONITORING`, tone: "bad" as const }
      : { value: "UNVERIFIED", tone: "bad" as const };
  }
  if (capital.status !== "ready") return { value: "UNVERIFIED", tone: "bad" as const };
  const potential = finiteNumber(capital.potential_releasable_micro_usdc);
  const reallocation = finiteNumber(capital.proposed_reallocation_micro_usdc);
  const avoided = finiteNumber(capital.potential_new_cash_avoided_micro_usdc);
  const newCash = finiteNumber(capital.new_owner_cash_requested_micro_usdc);
  const uncovered = finiteNumber(capital.uncovered_shortfall_micro_usdc);
  if (![potential, reallocation, avoided, newCash, uncovered].every(Number.isSafeInteger)
    || potential == null || reallocation == null || avoided == null || newCash == null || uncovered == null
    || potential < 0 || reallocation < 0 || avoided < 0 || newCash < 0 || uncovered < 0
    || reallocation > potential || avoided !== reallocation || uncovered > newCash
    || capital.owner_approval_required !== (reallocation > 0 || newCash > uncovered)) {
    return { value: "UNVERIFIED", tone: "bad" as const };
  }
  if (avoided > 0) {
    return { value: `${formatMicroUsd(avoided)} NEW CASH AVOIDED · OWNER MOVE`, tone: "good" as const };
  }
  if (newCash > 0) {
    return { value: `${formatMicroUsd(newCash)} NEW CASH NEEDED · OWNER`, tone: "warn" as const };
  }
  return { value: "NO NEW CASH NEEDED", tone: "good" as const };
}

function proofDepth(opportunity: Record<string, unknown>): {
  status: CarryQuoteModel["depthStatus"];
  minimumUsd: number | null;
} {
  const observations = (Array.isArray(opportunity.depth_impact) ? opportunity.depth_impact : [])
    .flatMap((venue) => {
      const row = asRecord(venue);
      return Array.isArray(row.observations) ? row.observations.map(asRecord) : [];
    });
  if (observations.length !== 4) return { status: "unavailable", minimumUsd: null };
  const statuses = observations.map((item) => stringValue(item.status));
  const displayed = observations
    .map((item) => microUsdValue(item.displayed_notional_micro_usdc))
    .filter((value): value is number => value != null);
  const minimumUsd = displayed.length === observations.length ? Math.min(...displayed) : null;
  if (statuses.includes("insufficient")) return { status: "insufficient", minimumUsd };
  return statuses.every((status) => status === "sufficient")
    ? { status: "sufficient", minimumUsd }
    : { status: "unavailable", minimumUsd };
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function microUsdValue(value: unknown) {
  const number = finiteNumber(value);
  return number == null ? null : number / 1_000_000;
}

function formatEconomicUsd(value: number | null) {
  return value == null ? "ACCOUNT DATA" : formatUsd(value);
}

function formatVerifiedEconomicUsd(value: number | null) {
  return value == null ? "UNVERIFIED" : formatUsd(value);
}

function carryRunwaySummary(observation: CarryRecord["latest_observation"] | null, candidate: CarryCandidate) {
  if (!observation) return { value: "PENDING", tone: undefined } as const;
  const venues = [candidate.long.venue_id, candidate.short.venue_id];
  const statuses = venues.map((venue) => observation.margin_runway_status_by_venue?.[venue]);
  const allowedStatuses = new Set(["healthy", "warning", "critical", "breached"]);
  if (statuses.some((status) => !status || !allowedStatuses.has(status))) {
    return { value: "UNVERIFIED", tone: "bad" } as const;
  }
  const values = venues.map((venue) => observation.margin_runway_ms_by_venue?.[venue]);
  if (values.some((value, index) => value === undefined
    || (value === null && statuses[index] !== "healthy")
    || (value !== null && (!Number.isFinite(value) || Number(value) < 0)))) {
    return { value: "UNVERIFIED", tone: "bad" } as const;
  }
  const worst = statuses.includes("breached") ? "breached"
    : statuses.includes("critical") ? "critical"
      : statuses.includes("warning") ? "warning"
        : "healthy";
  const legs = venues.map((venue, index) => `${runwayVenueCode(venue)} ${values[index] === null ? "∞" : formatRunway(Number(values[index]))}`);
  return {
    value: `${legs.join(" · ")} · ${worst.toUpperCase()}`,
    tone: worst === "healthy" ? "good" : worst === "warning" ? "warn" : "bad",
  } as const;
}

function carryFundingFlipSummary(
  position: CarryRecord["position"] | undefined,
  observation: CarryRecord["latest_observation"] | null,
) {
  if (!position || !observation) return { value: "PENDING", tone: undefined } as const;
  const expectedNetBps = observation.expected_net_value_bps;
  const exitNetBps = position.risk_mandate?.exit_net_value_bps;
  const consecutive = position.consecutive_exit_observations;
  const required = position.risk_mandate?.exit_after_consecutive_observations;
  if (![expectedNetBps, exitNetBps, consecutive, required].every(Number.isSafeInteger)
    || Number(consecutive) < 0 || Number(required) <= 0 || Number(consecutive) > Number(required)) {
    return { value: "UNVERIFIED", tone: "bad" } as const;
  }
  const adverse = Number(expectedNetBps) <= Number(exitNetBps);
  if ((adverse && Number(consecutive) === 0) || (!adverse && Number(consecutive) !== 0)) {
    return { value: "UNVERIFIED", tone: "bad" } as const;
  }
  const net = `${Number(expectedNetBps) >= 0 ? "+" : "−"}${Math.abs(Number(expectedNetBps))}BP`;
  if (!adverse) return { value: `${net} · CLEAR`, tone: "good" } as const;
  if (Number(consecutive) >= Number(required)) return { value: `${net} · EXIT`, tone: "bad" } as const;
  return { value: `${net} · ${consecutive}/${required} FLIPS`, tone: "warn" } as const;
}

function runwayVenueCode(venueId: string) {
  if (venueId === "hyperliquid") return "HYP";
  if (venueId === "lighter") return "LTR";
  if (venueId === "aster") return "AST";
  return venueName(venueId).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

function carryCapitalSummary(plan: NonNullable<CarryRecord["latest_observation"]>["capital_action_plan"]) {
  if (!plan) return { value: "PENDING", tone: undefined } as const;
  if (plan.transaction_broadcast !== false || plan.automatic_transfer_permitted !== false) {
    return { value: "UNVERIFIED", tone: "bad" } as const;
  }
  if (plan.status === "balanced") return { value: "BALANCED", tone: "good" } as const;
  if (plan.status === "quarantined") return { value: "RECONCILE ONLY", tone: "bad" } as const;
  if (plan.status === "exit_required") return { value: "REDUCE-ONLY EXIT", tone: "bad" } as const;
  const amount = plan.minimum_additional_collateral_micro_usdc;
  const leg = plan.legs?.find((item) => item.recommended_action === "owner_fund_venue");
  if (plan.status !== "owner_action_required" || !Number.isSafeInteger(amount) || Number(amount) <= 0 || !leg?.venue_id) {
    return { value: "OWNER REVIEW", tone: "warn" } as const;
  }
  return {
    value: `${formatUsd(Number(amount) / 1_000_000)} → ${venueName(leg.venue_id)} · OWNER`,
    tone: "warn",
  } as const;
}

export function carryLedgerSummary(record: CarryRecord | null) {
  const ledger = record?.value_ledger;
  if (!ledger) return { value: "PENDING", execution: "PENDING" } as const;
  const modeled = ledger.modeled?.net_value_micro_usdc;
  if (!Number.isSafeInteger(modeled)) return { value: "UNVERIFIED", execution: "UNVERIFIED", tone: "bad", executionTone: "bad" } as const;
  if (ledger.status !== "finalized") {
    return { value: `${formatMicroUsd(Number(modeled))} MODEL`, execution: "ACCRUING" } as const;
  }
  if (record?.position.status !== "reconciled"
    || record.value_boundary_authoritative !== true
    || record.position.active_boundary_provenance !== "authoritative_exchange_fill_time") {
    return { value: "UNVERIFIED", execution: "UNVERIFIED", tone: "bad", executionTone: "bad" } as const;
  }
  const realized = ledger.realized?.net_value_micro_usdc;
  const variance = ledger.realized?.variance_from_modeled_micro_usdc;
  if (!Number.isSafeInteger(realized) || !Number.isSafeInteger(variance)) {
    return { value: "UNVERIFIED", execution: "UNVERIFIED", tone: "bad", executionTone: "bad" } as const;
  }
  const attribution = ledger.realized?.attribution;
  const fee = attribution?.trading_fee_micro_usdc;
  const slippage = attribution?.slippage_micro_usdc;
  const executionVerified = attribution?.status === "finalized"
    && Number.isSafeInteger(fee)
    && Number.isSafeInteger(slippage);
  return {
    value: `${formatMicroUsd(Number(realized))} REAL · ${formatSignedMicroUsd(Number(variance))} Δ`,
    execution: executionVerified
      ? `FEE ${formatSignedMicroUsd(Number(fee))} · SLIP ${formatSignedMicroUsd(Number(slippage))}`
      : "NET PROOF ONLY",
    tone: Number(realized) >= 0 ? "good" : "bad",
    executionTone: executionVerified
      ? Number(fee) + Number(slippage) >= 0 ? "good" : "warn"
      : "warn",
  } as const;
}

function formatRunway(value: number) {
  if (!Number.isFinite(value)) return "∞";
  if (value < 60_000) return `${Math.max(0, Math.round(value / 1_000))}S`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)}M`;
  return `${(value / 3_600_000).toFixed(value < 36_000_000 ? 1 : 0)}H`;
}

function monitorAge(recordedAtMs: number | undefined) {
  if (!Number.isSafeInteger(recordedAtMs)) return "PENDING";
  const ageMs = Math.max(0, Date.now() - Number(recordedAtMs));
  return ageMs < 60_000 ? `${Math.round(ageMs / 1_000)}S AGO` : `${Math.round(ageMs / 60_000)}M AGO`;
}

function formatSkew(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value < 1_000 ? `${Math.round(value)}MS` : `${(value / 1_000).toFixed(1)}S`
    : "UNVERIFIED";
}

function formatBasis(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? `${Math.round(value)}BP`
    : "UNVERIFIED";
}

function venueName(venueId: string) {
  return (CARRY_VENUE_LABELS[venueId] || venueId).toUpperCase();
}

function formatUsd(value: number) {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatMicroUsd(value: number) {
  return formatUsd(value / 1_000_000);
}

function formatSignedMicroUsd(value: number) {
  return `${value >= 0 ? "+" : "−"}${formatUsd(Math.abs(value) / 1_000_000)}`;
}

function formatSigned(value: number) {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(Math.abs(value) >= 10 ? 1 : 2)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function shortReference(value: string) {
  return value.replace(/^ghola-/, "").slice(0, 12).toUpperCase();
}

export function carryCheckFailure(error: unknown, fallback: string) {
  const candidate = error && typeof error === "object" ? error as { message?: unknown; correlationId?: unknown } : {};
  const code = typeof candidate.message === "string" ? candidate.message : "carry_check_failed";
  const reference = shortReference(typeof candidate.correlationId === "string" ? candidate.correlationId : fallback);
  const venue = CARRY_EXECUTION_VENUES.find((venueId) => code === `${venueId}_account_not_ready`);
  const asterDepositRequired = code === "aster_deposit_required" || code === "carry_deposit_required:aster";
  return {
    label: asterDepositRequired
      ? "ASTER DEPOSIT REQUIRED"
      : carryCheckAuthenticationRequired(error)
        ? "SIGN-IN REQUIRED · NO ORDER SUBMITTED"
      : venue
        ? `${venueName(venue)} NOT READY`
        : code === "carry_worker_authorization_misconfigured"
          ? "AUTH MISMATCH"
          : code === "carry_worker_unavailable"
            ? "WORKER UNAVAILABLE"
            : "CHECK FAILED",
    reference,
  };
}

export function carryCheckAuthenticationRequired(error: unknown) {
  const candidate = error && typeof error === "object"
    ? error as { message?: unknown; status?: unknown; body?: unknown }
    : {};
  const body = asRecord(candidate.body);
  return candidate.status === 401
    || candidate.message === "private_account_auth_required"
    || body.error === "private_account_auth_required";
}

export function carryFleetGuardSummary(
  matrix: Record<string, unknown> | null,
  durableReady: boolean,
): { value: string; receipt: string; tone?: "good" | "warn" | "bad" } {
  if (durableReady) {
    return {
      value: `${CARRY_EXECUTION_VENUES.length} VENUES · READY`,
      receipt: "READY",
      tone: "good",
    };
  }
  const pairs = Array.isArray(matrix?.pairs) ? matrix.pairs.map(asRecord) : [];
  if (!pairs.length) {
    return {
      value: `${CARRY_EXECUTION_VENUES.length} VENUES · PENDING`,
      receipt: "PENDING",
    };
  }
  const readyPairs = pairs.filter((pair) => pair.no_submit_ready === true).length;
  const blockedVenues = CARRY_EXECUTION_VENUES.filter((venueId) => pairs.some((pair) => {
    const errorCode = stringValue(pair.error_code);
    return errorCode?.split(":").includes(venueId) === true;
  }));
  const detail = blockedVenues.length
    ? `${blockedVenues.map(venueName).join("/")} BLOCKED`
    : readyPairs === pairs.length
      ? "EVIDENCE BLOCKED"
      : "DEGRADED";
  const age = carryMatrixAge(matrix);
  return {
    value: `${readyPairs}/${pairs.length} PAIRS · ${detail}${age ? ` · ${age}` : ""}`,
    receipt: `${readyPairs}/${pairs.length} · ${detail}${age ? ` · ${age}` : ""}`,
    tone: readyPairs > 0 ? "warn" : "bad",
  };
}

export function carryMatrixPairReady(
  matrix: Record<string, unknown> | null,
  longVenueId: string,
  shortVenueId: string,
) {
  if (!matrix) return false;
  const selectedPair = asRecord(matrix.selected_pair);
  const selectedResult = asRecord(selectedPair.result);
  if (
    selectedPair.long_venue_id === longVenueId
    && selectedPair.short_venue_id === shortVenueId
    && selectedPair.transaction_broadcast === false
    && selectedResult.no_submit_ready === true
  ) return true;
  const pairs = Array.isArray(matrix.pairs) ? matrix.pairs.map(asRecord) : [];
  return pairs.some((pair) => {
    const samePair = (pair.long_venue_id === longVenueId && pair.short_venue_id === shortVenueId)
      || (pair.long_venue_id === shortVenueId && pair.short_venue_id === longVenueId);
    return samePair && pair.no_submit_ready === true && pair.transaction_broadcast === false;
  });
}

export function carrySupervisionSummary(value: Record<string, unknown>): {
  ready: boolean;
  value: string;
  tone?: "good" | "warn" | "bad";
} {
  const monitoring = asRecord(value.monitoring);
  const execution = asRecord(value.execution);
  const recovery = asRecord(value.recovery);
  const observation = asRecord(value.observation);
  if (
    value.ready === true
    && value.status === "healthy"
    && monitoring.status === "healthy"
    && execution.status === "healthy"
    && recovery.status === "healthy"
    && observation.status === "healthy"
  ) {
    return { ready: true, value: "DATA/MON/EXIT/REC LIVE", tone: "good" };
  }
  const degraded = [
    monitoring.status === "degraded" || monitoring.status === "failed" || monitoring.status === "stalled" ? "MONITOR" : null,
    execution.status === "degraded" || execution.status === "failed" || execution.status === "stalled" ? "EXIT" : null,
    recovery.status === "degraded" || recovery.status === "failed" || recovery.status === "stalled" ? "RECOVERY" : null,
    observation.status === "degraded" || observation.status === "failed" || observation.status === "stalled" ? "DATA" : null,
  ].filter(Boolean);
  if (degraded.length) return { ready: false, value: `${degraded.join(" + ")} DEGRADED`, tone: "bad" };
  if (value.status === "starting") return { ready: false, value: "STARTING", tone: "warn" };
  if (value.status === "disabled" || value.status === "stopped") return { ready: false, value: "OFFLINE", tone: "bad" };
  return { ready: false, value: "UNVERIFIED", tone: "warn" };
}

function readyStoredDiagnostic(value: Record<string, unknown>, asset: string, notional: string, days: string) {
  if (value.available !== true || value.diagnostic_only !== true || value.reusable_for_readiness !== false) return false;
  if (value.mode !== "carry_execution_no_submit_matrix_diagnostic" || value.transaction_broadcast !== false) return false;
  if (value.asset !== asset.toUpperCase() || Number(value.notional_usd) !== Number(notional) || Number(value.horizon_days) !== Number(days)) return false;
  if (!Number.isSafeInteger(value.checked_at_ms) || !Number.isSafeInteger(value.expires_at_ms) || Number(value.expires_at_ms) <= Date.now()) return false;
  if (typeof value.image_digest !== "string" || !value.image_digest.startsWith("sha256:")) return false;
  if (typeof value.diagnostic_commitment !== "string" || !value.diagnostic_commitment.startsWith("carry:diagnostic:evidence:")) return false;
  const expectedPairCount = CARRY_EXECUTION_VENUES.length * (CARRY_EXECUTION_VENUES.length - 1) / 2;
  if (!Array.isArray(value.pairs) || value.pairs.length !== expectedPairCount) return false;
  const registryVenueIds = value.registry_venue_ids;
  return Array.isArray(registryVenueIds)
    && registryVenueIds.length === CARRY_EXECUTION_VENUES.length
    && CARRY_EXECUTION_VENUES.every((venueId, index) => registryVenueIds[index] === venueId);
}

function matrixCheckedAtMs(value: Record<string, unknown> | null) {
  if (!value) return 0;
  if (Number.isSafeInteger(value.checked_at_ms)) return Number(value.checked_at_ms);
  const parsed = typeof value.checked_at === "string" ? Date.parse(value.checked_at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function carryMatrixAge(value: Record<string, unknown> | null) {
  const checkedAt = matrixCheckedAtMs(value);
  if (!checkedAt) return null;
  const ageMs = Math.max(0, Date.now() - checkedAt);
  if (ageMs < 60_000) return "<1M";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}M`;
  return `${Math.floor(ageMs / 3_600_000)}H`;
}

function readyNoSubmitMatrix(value: Record<string, unknown>, asset: string, notional: string, days: string) {
  if (value.mode !== "carry_execution_no_submit_matrix" ||
      value.no_submit_ready !== true ||
      value.transaction_broadcast !== false ||
      !Array.isArray(value.failures) || value.failures.length !== 0 ||
      !Array.isArray(value.venues) ||
      !readyStoredReadiness(asRecord(value.readiness), asset, notional, days)) return false;
  const venues = value.venues.map(asRecord);
  return CARRY_EXECUTION_VENUES.every((venueId) => venues.some((venue) =>
    venue.venue_id === venueId && venue.transaction_broadcast === false));
}

function readyStoredReadiness(value: Record<string, unknown> | null, asset: string, notional: string, days: string) {
  if (!value || value.ready !== true || value.network !== "mainnet" || value.asset !== asset.toUpperCase()) return false;
  if (Number(value.notional_usd) !== Number(notional) || Number(value.horizon_days) !== Number(days)) return false;
  if (!Number.isSafeInteger(value.expires_at_ms) || Number(value.expires_at_ms) <= Date.now()) return false;
  if (typeof value.image_digest !== "string" || !value.image_digest.startsWith("sha256:")) return false;
  if (typeof value.evidence_commitment !== "string" || !value.evidence_commitment.startsWith("carry:readiness:evidence:")) return false;
  const registryVenueIds = value.registry_venue_ids;
  return Array.isArray(registryVenueIds)
    && registryVenueIds.length === CARRY_EXECUTION_VENUES.length
    && CARRY_EXECUTION_VENUES.every((venueId, index) => registryVenueIds[index] === venueId);
}

function carryPositionSaveNeedsSetup(caught: unknown) {
  const message = caught instanceof Error ? caught.message : String(caught || "");
  return message === "carry_owner_auth_required" ||
    /authenticate with turnkey|perps identity boundary/i.test(message) ||
    /wallet provisioning failed|ghola perps wallet|wallet account .* unavailable|wallet binding/i.test(message) ||
    /turnkey signing client is unavailable/i.test(message);
}

function isCarryRecord(value: Record<string, unknown>): value is Record<string, unknown> & CarryRecord {
  const position = asRecord(value.position);
  return typeof position.position_id === "string"
    && typeof position.asset === "string"
    && typeof position.long_venue_id === "string"
    && typeof position.short_venue_id === "string"
    && Number.isSafeInteger(position.target_notional_micro_usdc)
    && typeof position.status === "string"
    && Number.isSafeInteger(position.last_event_sequence)
    && Array.isArray(position.next_actions);
}
