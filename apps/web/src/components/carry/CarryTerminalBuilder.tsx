"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  createCarryPosition,
  executeCarryPositionEntry,
  getPrivateAgentPassport,
  listCarryPositions,
  preflightCarryExecutionMatrix,
  preflightCarryPair,
  requestCarryPositionExit,
} from "@/lib/private-account-client";
import {
  buildCarryRiskMandatePayload,
  carryRiskMandateAuthorization,
} from "@/lib/carry-risk-mandate";
import { builderModel, CARRY_VENUE_LABELS, type CarryCandidate } from "@/lib/carry-market";
import { isCarryExecutionVenue, type CarryExecutionVenue } from "@/lib/carry-venues";
import { usePerpsTurnkey } from "@/lib/perps-turnkey-provider";

type CarryRecord = {
  qualification_pilot?: { enabled?: boolean; candidate_venue_id?: string };
  position: {
    position_id: string;
    asset: string;
    long_venue_id: string;
    short_venue_id: string;
    status: string;
    next_actions: string[];
    last_event_sequence: number;
  };
  final_reconciliation_evidence?: {
    gross_exposure_micro_usdc?: number;
    open_order_count?: number;
  };
  latest_observation?: {
    expected_net_value_bps?: number;
    margin_runway_ms_by_venue?: Record<string, number | null>;
    margin_runway_status_by_venue?: Record<string, "healthy" | "warning" | "critical" | "breached">;
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

  const routeRecords = records.filter((record) => record.position.asset === candidate.asset
    && record.position.long_venue_id === candidate.long.venue_id
    && record.position.short_venue_id === candidate.short.venue_id);
  const current = routeRecords.find((record) =>
    !["reconciled", "manual_intervention"].includes(record.position.status)) || null;
  const lastFlat = routeRecords.some((record) => record.position.status === "reconciled"
    && record.final_reconciliation_evidence?.gross_exposure_micro_usdc === 0
    && record.final_reconciliation_evidence?.open_order_count === 0);
  const latestObservation = current?.latest_observation || null;
  const runway = carryRunwaySummary(latestObservation, candidate);

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
      const matrix = asRecord(await preflightCarryExecutionMatrix({
        asset: candidate.asset,
        notional_usd: notional,
        horizon_days: days,
      }));
      if (!readyNoSubmitMatrix(matrix)) {
        setLastCheckReceipt(`${checkedRoute} · THREE-VENUE NOT READY · REF ${shortReference(stringValue(matrix.correlation_id) || localReference)}`);
        return;
      }
      const result = asRecord(await preflightCarryPair({
        asset: candidate.asset,
        long_venue_id: candidate.long.venue_id as CarryExecutionVenue,
        short_venue_id: candidate.short.venue_id as CarryExecutionVenue,
        notional_usd: notional,
        horizon_days: days,
      }));
      setProof({ ...result, execution_matrix: matrix });
      const outcome = result.live_creation_ready === true
        ? "READY · exact account costs, margin runway and both order shapes verified"
        : result.qualification_pilot_ready === true
          ? "PROOF READY · one capped qualification lifecycle can be armed"
          : result.no_submit_ready === true
            ? "CHECKED · execution remains locked pending venue qualification"
            : "NOT READY · connect and fund both trade-only accounts";
      const matrixReference = shortReference(stringValue(matrix.correlation_id) || localReference);
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
    const riskMandate = {
      min_expected_net_benefit_bps: 5,
      exit_net_value_bps: 0,
      exit_after_consecutive_observations: 2,
      min_margin_runway_ms: 6 * 3_600_000,
      max_hedge_error_micro_usdc: 10_000,
      max_data_age_ms: 60_000,
      allow_migration: false,
    };
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
          mandate_authorization: carryRiskMandateAuthorization({ signed_mandate: signedMandate, signature }),
        },
        opportunity,
        ...(pilot ? { qualification_pilot: { enabled: true as const, candidate_venue_id: pilot } } : {}),
      }));
      if (result.ok !== true) throw new Error("carry_position_not_saved");
      setMessage("OWNER-SIGNED · no order submitted; live paired entry requires the button below");
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
        <Metric label="FEES + SLIP" value={model.costUsd == null ? "ACCOUNT DATA" : formatUsd(model.costUsd)} />
        <Metric label={`NET / ${days}D`} value={model.netUsd == null ? "ACCOUNT DATA" : formatUsd(model.netUsd)} tone={model.netUsd != null && model.netUsd > 0 ? "good" : undefined} />
        <Metric label="BREAK-EVEN" value={model.breakEvenDays == null ? "—" : `${model.breakEvenDays.toFixed(1)}D`} />
        <Metric label="COLLATERAL" value={formatUsd(model.minimumCollateralUsd)} />
        <Metric label="MIN RUNWAY" value={runway.value} tone={runway.tone} />
        <Metric label="MONITOR" value={monitorAge(latestObservation?.recorded_at_ms)} />
      </div>

      <div className="grid gap-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <label className="rounded border border-[#202a37] bg-[#070a0f] px-2 py-1 font-mono text-[9px] text-[#687589]">
            NOTIONAL / LEG
            <span className="mt-0.5 flex items-center text-[11px] text-[#d7dde6]">$<input aria-label="Carry notional per leg" value={notional} onChange={(event) => invalidateProof(setNotional)(event.target.value)} inputMode="decimal" className="min-w-0 flex-1 bg-transparent pl-1 outline-none" /></span>
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
              {busy === "check" ? "CHECKING…" : executionPair ? "NO-SUBMIT CHECK" : "READ-ONLY ROUTE"}
            </button>
          ) : !current && canSave ? (
            <button type="button" disabled={busy !== null} onClick={() => void savePosition()} className="rounded border border-[#31577a] bg-[#10243a] px-2 py-2 font-mono text-[10px] font-semibold text-[#b7ddff] disabled:opacity-40">
              {busy === "save" ? "SAVING…" : proof?.qualification_pilot_ready === true ? "ARM CAPPED PROOF" : "SAVE POSITION"}
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

function venueName(venueId: string) {
  return (CARRY_VENUE_LABELS[venueId] || venueId).toUpperCase();
}

function formatUsd(value: number) {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
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
  const venue = code.match(/^(hyperliquid|lighter|aster)_account_not_ready$/)?.[1];
  return {
    label: venue ? `${venueName(venue)} NOT READY` : code === "carry_worker_unavailable" ? "WORKER UNAVAILABLE" : "CHECK FAILED",
    reference,
  };
}

function readyNoSubmitMatrix(value: Record<string, unknown>) {
  if (value.mode !== "carry_execution_no_submit_matrix" ||
      value.no_submit_ready !== true ||
      value.transaction_broadcast !== false ||
      !Array.isArray(value.failures) || value.failures.length !== 0 ||
      !Array.isArray(value.venues)) return false;
  const venues = value.venues.map(asRecord);
  return ["hyperliquid", "lighter", "aster"].every((venueId) => venues.some((venue) =>
    venue.venue_id === venueId && venue.transaction_broadcast === false));
}

function isCarryRecord(value: Record<string, unknown>): value is Record<string, unknown> & CarryRecord {
  const position = asRecord(value.position);
  return typeof position.position_id === "string"
    && typeof position.asset === "string"
    && Array.isArray(position.next_actions);
}
