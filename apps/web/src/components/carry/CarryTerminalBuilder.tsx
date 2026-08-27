"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  createCarryPosition,
  executeCarryPositionEntry,
  getCarryExecutionReadiness,
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

type CarryRecord = {
  qualification_pilot?: { enabled?: boolean; candidate_venue_id?: string };
  position: {
    position_id: string;
    asset: string;
    long_venue_id: string;
    short_venue_id: string;
    target_notional_micro_usdc: number;
    status: string;
    next_actions: string[];
    last_event_sequence: number;
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

export const CarryTerminalBuilder = memo(function CarryTerminalBuilder({
  candidate,
}: {
  candidate: CarryCandidate;
}) {
  const perpsTurnkey = usePerpsTurnkey();
  const [notional, setNotional] = useState("11");
  const [days, setDays] = useState("30");
  const [proof, setProof] = useState<Record<string, unknown> | null>(null);
  const [readiness, setReadiness] = useState<Record<string, unknown> | null>(null);
  const [records, setRecords] = useState<CarryRecord[]>([]);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [busy, setBusy] = useState<"check" | "save" | "enter" | "exit" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastCheckReceipt, setLastCheckReceipt] = useState<string | null>(null);
  const routeKey = `${candidate.asset}:${candidate.long.venue_id}:${candidate.short.venue_id}`;
  const model = useMemo(() => builderModel(candidate, notional, days), [candidate, days, notional]);
  const executionPair = isCarryExecutionVenue(candidate.long.venue_id)
    && isCarryExecutionVenue(candidate.short.venue_id);

  const loadRecords = useCallback(async () => {
    setRecordsLoading(true);
    try {
      const result = asRecord(await listCarryPositions());
      const next = Array.isArray(result.records) ? result.records.map(asRecord).filter(isCarryRecord) : [];
      setRecords(next);
      setRecordsLoaded(true);
    } catch {
      // Preserve the last authoritative view and fail closed if the initial sync failed.
    } finally {
      setRecordsLoading(false);
    }
  }, []);

  useEffect(() => {
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
  }, [loadRecords]);
  useEffect(() => {
    setProof(null);
    setMessage(null);
  }, [routeKey]);
  useEffect(() => {
    let cancelled = false;
    void getCarryExecutionReadiness({
      asset: candidate.asset,
      notional_usd: notional,
      horizon_days: days,
    })
      .then((value) => {
        if (!cancelled) setReadiness(asRecord(value));
      })
      .catch(() => {
        if (!cancelled) setReadiness(null);
      });
    return () => { cancelled = true; };
  }, [candidate.asset, days, notional, routeKey]);

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
  const capital = carryCapitalSummary(latestObservation?.capital_action_plan);
  const ledger = carryLedgerSummary(current?.value_ledger);
  const proofOpportunity = proof ? asRecord(proof.creation_opportunity) : null;
  const economics = carryTerminalEconomics(model, proofOpportunity);
  const restoredReadiness = readyStoredReadiness(readiness, candidate.asset, notional, days);

  const invalidateProof = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setProof(null);
    setMessage(null);
  };

  async function runCheck() {
    if (!executionPair) return;
    const localReference = shortReference(`ghola-${Date.now().toString(36)}`);
    const checkedRoute = `${candidate.asset} · L ${venueName(candidate.long.venue_id)} / S ${venueName(candidate.short.venue_id)}`;
    setBusy("check");
    setMessage(null);
    setProof(null);
    setLastCheckReceipt(`${checkedRoute} · CHECKING · REF ${localReference}`);
    try {
      let matrix: Record<string, unknown> | null = null;
      let activeReadiness = restoredReadiness ? readiness : null;
      if (!activeReadiness) {
        matrix = asRecord(await preflightCarryExecutionMatrix({
          asset: candidate.asset,
          notional_usd: notional,
          horizon_days: days,
        }));
        if (!readyNoSubmitMatrix(matrix, candidate.asset, notional, days)) {
          setReadiness(null);
          setLastCheckReceipt(`${checkedRoute} · THREE-VENUE NOT READY · REF ${shortReference(stringValue(matrix.correlation_id) || localReference)}`);
          return;
        }
        activeReadiness = asRecord(matrix.readiness);
        setReadiness(activeReadiness);
      }
      const result = asRecord(await preflightCarryPair({
        asset: candidate.asset,
        long_venue_id: candidate.long.venue_id as CarryExecutionVenue,
        short_venue_id: candidate.short.venue_id as CarryExecutionVenue,
        notional_usd: notional,
        horizon_days: days,
      }));
      setProof({
        ...result,
        ...(matrix ? { execution_matrix: matrix } : { execution_readiness: activeReadiness }),
      });
      const outcome = result.live_creation_ready === true
        ? "READY · synchronized market data, exact costs, margin runway and both order shapes verified"
        : result.qualification_pilot_ready === true
          ? "PROOF READY · one capped qualification lifecycle can be armed"
          : result.no_submit_ready === true
            ? "CHECKED · execution remains locked pending venue qualification"
            : "NOT READY · connect and fund both trade-only accounts";
      const matrixReference = shortReference(
        stringValue(matrix?.correlation_id)
        || stringValue(activeReadiness?.evidence_commitment)
        || localReference,
      );
      const pairReference = shortReference(stringValue(result.correlation_id) || localReference);
      setLastCheckReceipt(`${checkedRoute} · ${outcome} · MATRIX ${matrixReference} · PAIR ${pairReference}`);
    } catch (error) {
      const failure = carryCheckFailure(error, localReference);
      setLastCheckReceipt(`${checkedRoute} · ${failure.label} · REF ${failure.reference}`);
    } finally {
      setBusy(null);
    }
  }

  async function savePosition() {
    if (!proof) return;
    const opportunity = asRecord(proof.creation_opportunity);
    const pilotVenue = stringValue(proof.qualification_pilot_candidate_venue_id);
    const pilot = proof.qualification_pilot_ready === true && isCarryExecutionVenue(pilotVenue)
      ? pilotVenue
      : null;
    if (proof.live_creation_ready !== true && !pilot) return;
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
          risk_mandate: riskMandate,
          ...migrationLineage,
          mandate_authorization: carryRiskMandateAuthorization({ signed_mandate: signedMandate, signature }),
        },
        opportunity,
        ...(pilot ? { qualification_pilot: { enabled: true as const, candidate_venue_id: pilot } } : {}),
      }));
      if (result.ok !== true) throw new Error("carry_position_not_saved");
      setMessage(migrationSource
        ? "MIGRATION SIGNED · parent is flat; replacement entry still requires the button below"
        : "OWNER-SIGNED · no order submitted; live paired entry requires the button below");
      await loadRecords();
    } catch {
      setMessage("NOT SAVED · refresh the route and rerun the no-submit check");
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

  const terminalReturn = `/trade?product=perps&venue=hyperliquid&market=${candidate.asset}-PERP&carry=open`;
  const setupHref = `/account?setup=carry&return_to=${encodeURIComponent(terminalReturn)}`;
  const canSave = proof?.live_creation_ready === true || proof?.qualification_pilot_ready === true;
  const canEnter = current?.position.status === "draft";
  const canExit = current ? ["active", "rebalancing", "frozen"].includes(current.position.status) : false;
  return (
    <div className="mt-2 grid gap-2 border-t border-[#1d2733] pt-2 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]" aria-label="Carry position builder">
      <div className="grid gap-1.5 sm:grid-cols-4">
        <Metric label="ROUTE" value={`L ${venueName(candidate.long.venue_id)} / S ${venueName(candidate.short.venue_id)}`} />
        <Metric label="GROSS" value={`${formatSigned(candidate.grossAnnualBps / 365)} BP/D`} tone="good" />
        <Metric label="FEES" value={economics.fees} />
        <Metric label="SLIPPAGE" value={economics.slippage} tone={economics.depthTone} />
        <Metric label="USABLE DEPTH" value={economics.depth} tone={economics.depthTone} />
        <Metric label={`NET / ${days}D`} value={economics.net} tone={economics.netTone} />
        <Metric label="BREAK-EVEN" value={economics.breakEven} />
        <Metric label="COLLATERAL" value={formatUsd(model.minimumCollateralUsd)} />
        <Metric label="MIN RUNWAY" value={runway.value} tone={runway.tone} />
        <Metric label="CAPITAL" value={capital.value} tone={capital.tone} />
        <Metric label="LEDGER" value={ledger.value} tone={ledger.tone} />
        <Metric label="EXEC Δ" value={ledger.execution} tone={ledger.executionTone} />
        <Metric label="SOURCE SYNC" value={proofOpportunity ? formatSkew(proofOpportunity.contract_data_skew_ms) : "PENDING"} />
        <Metric label="INDEX BASIS" value={proofOpportunity ? formatBasis(proofOpportunity.index_price_divergence_bps) : "PENDING"} />
        <Metric label="ROUTE GUARD" value={`${CARRY_EXECUTION_VENUES.length} VENUES · ${restoredReadiness ? "READY" : "PENDING"}`} tone={restoredReadiness ? "good" : undefined} />
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
          <Link href={setupHref} className="rounded border border-[#293a50] px-2 py-2 text-center font-mono text-[10px] font-semibold text-[#8fbbe2] hover:bg-[#0d1622]">CONNECT</Link>
          {!recordsLoaded ? (
            <button type="button" disabled={recordsLoading} onClick={() => void loadRecords()} className="rounded border border-[#594b2b] bg-[#1e190c] px-2 py-2 font-mono text-[10px] font-semibold text-[#d9bd74] disabled:opacity-40">
              {recordsLoading ? "SYNCING POSITIONS…" : "RETRY POSITION SYNC"}
            </button>
          ) : !current && !canSave ? (
            <button type="button" disabled={!executionPair || busy !== null} onClick={() => void runCheck()} className="rounded border border-[#285040] bg-[#0a1b16] px-2 py-2 font-mono text-[10px] font-semibold text-[#75d9b0] disabled:opacity-40">
              {busy === "check" ? "CHECKING…" : executionPair ? restoredReadiness ? "CHECK ROUTE · MATRIX READY" : "NO-SUBMIT CHECK" : "READ-ONLY ROUTE"}
            </button>
          ) : !current && canSave ? (
            <button type="button" disabled={busy !== null} onClick={() => void savePosition()} className="rounded border border-[#31577a] bg-[#10243a] px-2 py-2 font-mono text-[10px] font-semibold text-[#b7ddff] disabled:opacity-40">
              {busy === "save" ? "SAVING…" : migrationSource ? "SIGN MIGRATION" : proof?.qualification_pilot_ready === true ? "ARM CAPPED PROOF" : "SAVE POSITION"}
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
      </div>
    </div>
  );
});

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  const color = tone === "good" ? "text-[#72dfb2]" : tone === "warn" ? "text-[#d9bd74]" : tone === "bad" ? "text-[#ef929e]" : "text-[#c8d0dc]";
  return <div className="rounded border border-[#1d2733] bg-[#070a0f] px-2 py-1"><p className="font-mono text-[9px] text-[#5f6c7e]">{label}</p><p className={`mt-0.5 truncate font-mono text-[10px] ${color}`}>{value}</p></div>;
}

function carryTerminalEconomics(model: ReturnType<typeof builderModel>, opportunity: Record<string, unknown> | null) {
  const proofFee = microUsdValue(opportunity?.projected_trading_fee_micro_usdc);
  const proofSlippage = microUsdValue(opportunity?.projected_slippage_micro_usdc);
  const proofNet = microUsdValue(opportunity?.projected_net_value_micro_usdc);
  const proofBreakEvenMs = finiteNumber(opportunity?.break_even_ms);
  const depth = opportunity ? proofDepth(opportunity) : {
    status: model.depthStatus,
    minimumUsd: model.minimumDisplayedDepthUsd,
  };
  const netUsd = proofNet ?? model.netUsd;
  return {
    fees: formatEconomicUsd(proofFee ?? model.tradingFeeUsd),
    slippage: depth.status === "sufficient"
      ? formatEconomicUsd(proofSlippage ?? model.slippageUsd)
      : depth.status === "insufficient" ? "DEPTH LIMITED" : "UNVERIFIED",
    depth: depth.status === "sufficient" && depth.minimumUsd != null
      ? `${formatUsd(depth.minimumUsd)} MIN`
      : depth.status.toUpperCase(),
    depthTone: depth.status === "sufficient" ? "good" as const : depth.status === "insufficient" ? "bad" as const : "warn" as const,
    net: formatEconomicUsd(netUsd),
    netTone: netUsd != null && netUsd > 0 ? "good" as const : undefined,
    breakEven: proofBreakEvenMs != null
      ? `${(proofBreakEvenMs / 86_400_000).toFixed(1)}D`
      : model.breakEvenDays == null ? "—" : `${model.breakEvenDays.toFixed(1)}D`,
  };
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

function carryRunwaySummary(observation: CarryRecord["latest_observation"] | null, candidate: CarryCandidate) {
  if (!observation) return { value: "PENDING", tone: undefined } as const;
  const venues = [candidate.long.venue_id, candidate.short.venue_id];
  const statuses = venues.map((venue) => observation.margin_runway_status_by_venue?.[venue]);
  if (statuses.some((status) => !status)) return { value: "UNVERIFIED", tone: "bad" } as const;
  const values = venues.map((venue) => observation.margin_runway_ms_by_venue?.[venue]);
  if (values.some((value) => value === undefined)) return { value: "UNVERIFIED", tone: "bad" } as const;
  const finite = values.filter((value): value is number => typeof value === "number");
  const minimum = finite.length > 0 ? Math.min(...finite) : Number.POSITIVE_INFINITY;
  const worst = statuses.includes("breached") ? "breached"
    : statuses.includes("critical") ? "critical"
      : statuses.includes("warning") ? "warning"
        : "healthy";
  return {
    value: `${formatRunway(minimum)} · ${worst.toUpperCase()}`,
    tone: worst === "healthy" ? "good" : worst === "warning" ? "warn" : "bad",
  } as const;
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

function carryLedgerSummary(ledger: CarryRecord["value_ledger"]) {
  if (!ledger) return { value: "PENDING", execution: "PENDING" } as const;
  const modeled = ledger.modeled?.net_value_micro_usdc;
  if (!Number.isSafeInteger(modeled)) return { value: "UNVERIFIED", execution: "UNVERIFIED", tone: "bad", executionTone: "bad" } as const;
  if (ledger.status !== "finalized") {
    return { value: `${formatMicroUsd(Number(modeled))} MODEL`, execution: "ACCRUING" } as const;
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

function carryCheckFailure(error: unknown, fallback: string) {
  const candidate = error && typeof error === "object" ? error as { message?: unknown; correlationId?: unknown } : {};
  const code = typeof candidate.message === "string" ? candidate.message : "carry_check_failed";
  const reference = shortReference(typeof candidate.correlationId === "string" ? candidate.correlationId : fallback);
  const venue = CARRY_EXECUTION_VENUES.find((venueId) => code === `${venueId}_account_not_ready`);
  return {
    label: venue ? `${venueName(venue)} NOT READY` : code === "carry_worker_unavailable" ? "WORKER UNAVAILABLE" : "CHECK FAILED",
    reference,
  };
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
