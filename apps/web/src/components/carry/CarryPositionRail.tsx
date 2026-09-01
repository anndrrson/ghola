"use client";

import { useEffect, useMemo, useState } from "react";
import { CARRY_VENUE_LABELS } from "@/lib/carry-market";
import { hasExactCarryFlatReconciliation } from "@/lib/carry-reconciliation";
import { listCarryPositions } from "@/lib/private-account-client";
import { useThumperAuth } from "@/lib/thumper-auth-context";

type SyncState = "checking" | "signed_out" | "syncing" | "ready" | "stale" | "unavailable";

export interface CarryPositionRailRecord {
  updated_at?: string;
  value_boundary_authoritative?: boolean;
  position: {
    position_id: string;
    asset: string;
    long_venue_id: string;
    short_venue_id: string;
    target_notional_micro_usdc: number;
    status: string;
    next_actions?: string[];
    active_boundary_provenance?: string | null;
  };
  value_ledger?: {
    status?: "open" | "finalized";
    modeled?: { net_value_micro_usdc?: number };
    realized?: { net_value_micro_usdc?: number };
  };
  final_reconciliation_evidence?: {
    owner_commitment?: string;
    carry_position_id?: string;
    gross_exposure_micro_usdc?: number;
    open_order_count?: number;
    account_state_checked?: boolean;
    transaction_broadcast?: boolean;
    checked_at_ms?: number;
    reconciliation_commitment?: string;
    venues?: Array<{
      venue_id?: string;
      account_commitment?: string;
      authorized?: boolean;
      flat_zero_orders?: boolean;
      position_count?: number;
      open_order_count?: number;
      account_state_checked?: boolean;
    }>;
  };
  latest_observation?: {
    expected_net_value_bps?: number;
    margin_runway_ms_by_venue?: Record<string, number | null>;
    margin_runway_status_by_venue?: Record<string, "healthy" | "warning" | "critical" | "breached">;
    recorded_at_ms?: number;
  };
}

const POSITION_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  manual_intervention: 0,
  frozen: 1,
  exiting: 2,
  rebalancing: 3,
  active: 4,
  draft: 5,
  reconciled: 7,
});

export function CarryPositionRail() {
  const auth = useThumperAuth();
  const privateSessionReady = auth.authenticated && !auth.loading;
  const userScope = auth.user?.id || "";
  const [clock, setClock] = useState(() => Date.now());
  const [snapshot, setSnapshot] = useState<{
    records: CarryPositionRailRecord[];
    status: SyncState;
  }>({ records: [], status: auth.loading ? "checking" : "signed_out" });

  useEffect(() => {
    if (!privateSessionReady) {
      setSnapshot({ records: [], status: auth.loading ? "checking" : "signed_out" });
      return;
    }
    let stopped = false;
    let timer: number | null = null;
    setSnapshot({ records: [], status: "syncing" });
    const refresh = async () => {
      try {
        const response = record(await listCarryPositions());
        const records = Array.isArray(response.records)
          ? response.records.filter(isCarryPositionRailRecord)
          : [];
        if (!stopped) setSnapshot({ records, status: "ready" });
      } catch {
        if (!stopped) {
          setSnapshot((current) => current.records.length > 0
            ? { ...current, status: "stale" }
            : { records: [], status: "unavailable" });
        }
      } finally {
        if (!stopped) timer = window.setTimeout(refresh, document.hidden ? 30_000 : 5_000);
      }
    };
    void refresh();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [auth.loading, privateSessionReady, userScope]);

  const selected = useMemo(() => selectCarryPositionRecord(snapshot.records), [snapshot.records]);
  const selectedPositionId = selected?.position.position_id;
  const selectedHasNextAction = Boolean(selected?.position.next_actions?.[0]);
  const observationAtMs = selected?.latest_observation?.recorded_at_ms
    ?? parseTimestamp(selected?.updated_at);

  useEffect(() => {
    if (!selectedPositionId || selectedHasNextAction) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [selectedHasNextAction, selectedPositionId]);

  if (!selected) {
    return (
      <section
        aria-label="Carry position"
        data-sync-state={snapshot.status}
        className="mb-2 overflow-hidden rounded-md border border-[#252f3d] bg-[#090d13]"
      >
        <div className="flex min-h-10 items-center gap-3 px-2.5 font-mono text-[10px] sm:px-3">
          <span className="font-semibold tracking-[0.12em] text-[#78bdff]">POSITION</span>
          <span role="status" className={emptyStateTone(snapshot.status)}>{emptyStateLabel(snapshot.status)}</span>
          <span className="ml-auto text-[#657286]">SCANNER REMAINS READ-ONLY</span>
        </div>
      </section>
    );
  }

  const status = selected.position.status;
  const route = `L ${venueName(selected.position.long_venue_id)} / S ${venueName(selected.position.short_venue_id)}`;
  const modeledNet = microUsd(selected.value_ledger?.modeled?.net_value_micro_usdc);
  const ledgerMetric = positionLedgerMetric(selected);
  const runway = positionRunway(selected);
  const nextAction = selected.position.next_actions?.[0];
  const exactFlat = status === "reconciled" && hasExactCarryFlatReconciliation(
    selected.final_reconciliation_evidence,
    [selected.position.long_venue_id, selected.position.short_venue_id],
  ) && selected.final_reconciliation_evidence?.carry_position_id === selected.position.position_id;

  return (
    <section
      aria-label="Carry position"
      data-position-status={status}
      data-sync-state={snapshot.status}
      className="mb-2 overflow-x-auto rounded-md border border-[#2a3544] bg-[#090d13]"
    >
      <div className="grid min-h-10 min-w-[64rem] grid-cols-[7.25rem_5.5rem_minmax(12rem,1fr)_7rem_7rem_6.5rem_7rem_7rem] items-center gap-x-2 px-2.5 font-mono text-[10px] tabular-nums sm:px-3">
        <span className="flex items-center gap-1.5 font-semibold tracking-[0.12em] text-[#78bdff]">
          POSITION
          <span className={`rounded border px-1 py-0.5 text-[8px] tracking-[0.08em] ${positionStatusTone(status)}`}>
            {statusLabel(status)}
          </span>
          {snapshot.status === "stale" ? <span className="text-[8px] text-[#d9bd74]">STALE</span> : null}
        </span>
        <span className="font-semibold text-[#d7dde6]">{selected.position.asset}-PERP</span>
        <span className="truncate text-[#c8d0dc]" title={route}>{route}</span>
        <RailMetric label="NOTIONAL" value={`${formatUsdMicro(selected.position.target_notional_micro_usdc)}/LEG`} />
        <RailMetric label="MODEL NET" value={modeledNet} tone={signedTone(selected.value_ledger?.modeled?.net_value_micro_usdc)} />
        <RailMetric
          label={ledgerMetric.label}
          value={ledgerMetric.value}
          tone={ledgerMetric.tone}
        />
        <RailMetric label="RUNWAY" value={runway.value} tone={runway.tone} />
        <RailMetric
          label={exactFlat ? "FINAL" : nextAction ? "NEXT" : "AGE"}
          value={exactFlat ? "FLAT · 0 ORDERS" : nextAction ? statusLabel(nextAction) : formatAge(observationAtMs === null ? Number.NaN : clock - observationAtMs)}
          title={exactFlat ? "Both exact venue accounts are flat with zero open orders" : nextAction || undefined}
        />
      </div>
    </section>
  );
}

function positionLedgerMetric(record: CarryPositionRailRecord): {
  label: "REAL NET" | "VALUE";
  value: string;
  tone?: "good" | "warn" | "bad";
} {
  const positionStatus = record.position.status;
  const ledgerStatus = record.value_ledger?.status;
  const realized = record.value_ledger?.realized?.net_value_micro_usdc;
  if (positionStatus === "reconciled" && ledgerStatus === "finalized") {
    if (record.value_boundary_authoritative === true
      && record.position.active_boundary_provenance === "authoritative_exchange_fill_time"
      && Number.isFinite(realized)) {
      return { label: "REAL NET", value: microUsd(realized), tone: signedTone(realized) };
    }
    return { label: "VALUE", value: "UNVERIFIED", tone: "warn" };
  }
  if (positionStatus === "reconciled" && ledgerStatus === "open") {
    return { label: "VALUE", value: "FINALIZING", tone: "warn" };
  }
  if (["active", "rebalancing"].includes(positionStatus) && ledgerStatus === "open") {
    return { label: "VALUE", value: "ACCRUING" };
  }
  if (positionStatus === "exiting" && ledgerStatus === "open") {
    return { label: "VALUE", value: "REDUCING · RECONCILING", tone: "warn" };
  }
  return { label: "VALUE", value: "UNVERIFIED", tone: "warn" };
}

function RailMetric({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
  title?: string;
}) {
  const color = tone === "good"
    ? "text-[#72dfb2]"
    : tone === "warn"
      ? "text-[#d9bd74]"
      : tone === "bad"
        ? "text-[#ef929e]"
        : "text-[#c8d0dc]";
  return (
    <span className="min-w-0 whitespace-nowrap" title={title || value}>
      <span className="mr-1 text-[8px] text-[#5f6c7e]">{label}</span>
      <span className={`font-semibold ${color}`}>{value}</span>
    </span>
  );
}

export function selectCarryPositionRecord(
  records: readonly CarryPositionRailRecord[],
): CarryPositionRailRecord | null {
  let selected: CarryPositionRailRecord | null = null;
  for (const candidate of records) {
    if (!selected || comparePositionRecords(candidate, selected) < 0) selected = candidate;
  }
  return selected;
}

function comparePositionRecords(left: CarryPositionRailRecord, right: CarryPositionRailRecord) {
  const priority = positionPriority(left.position.status) - positionPriority(right.position.status);
  if (priority !== 0) return priority;
  return (parseTimestamp(right.updated_at) ?? 0) - (parseTimestamp(left.updated_at) ?? 0);
}

function positionPriority(status: string) {
  return POSITION_PRIORITY[status] ?? 5;
}

function positionRunway(record: CarryPositionRailRecord): {
  value: string;
  tone?: "good" | "warn" | "bad";
} {
  const observation = record.latest_observation;
  const byVenue = observation?.margin_runway_ms_by_venue || {};
  const routeValues = [record.position.long_venue_id, record.position.short_venue_id]
    .map((venueId) => byVenue[venueId])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  if (routeValues.length !== 2) return { value: "UNVERIFIED", tone: "warn" };
  const minimum = Math.min(...routeValues);
  const statuses = observation?.margin_runway_status_by_venue || {};
  const severity = [record.position.long_venue_id, record.position.short_venue_id]
    .map((venueId) => statuses[venueId])
    .reduce((worst, value) => Math.max(worst, runwaySeverity(value)), 0);
  return {
    value: `${formatRunway(minimum)} MIN`,
    tone: severity >= 3 ? "bad" : severity >= 1 ? "warn" : "good",
  };
}

function runwaySeverity(value: string | undefined) {
  if (value === "breached") return 3;
  if (value === "critical") return 2;
  if (value === "warning") return 1;
  return 0;
}

function isCarryPositionRailRecord(value: unknown): value is CarryPositionRailRecord {
  const candidate = record(value);
  const position = record(candidate.position);
  return typeof position.position_id === "string"
    && typeof position.asset === "string"
    && typeof position.long_venue_id === "string"
    && typeof position.short_venue_id === "string"
    && typeof position.status === "string"
    && Number.isSafeInteger(position.target_notional_micro_usdc);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function venueName(venueId: string) {
  return (CARRY_VENUE_LABELS[venueId] || venueId).toUpperCase();
}

function statusLabel(value: string) {
  if (value === "exiting") return "REDUCING · RECONCILING";
  return value.replaceAll("_", " ").toUpperCase();
}

function positionStatusTone(status: string) {
  if (status === "active") return "border-[#285040] text-[#72bfa2]";
  if (status === "reconciled") return "border-[#35465c] text-[#aeb9c7]";
  if (status === "exiting") return "border-[#6b4d25] text-[#d9bd74]";
  if (["frozen", "manual_intervention"].includes(status)) return "border-[#684b55] text-[#ef929e]";
  return "border-[#6b4d25] text-[#d9bd74]";
}

function emptyStateLabel(status: SyncState) {
  if (status === "checking") return "CHECKING SIGN-IN…";
  if (status === "signed_out") return "SIGN IN TO SYNC";
  if (status === "syncing") return "SYNCING…";
  if (status === "unavailable") return "SYNC UNAVAILABLE";
  return "NONE · FLAT";
}

function emptyStateTone(status: SyncState) {
  if (status === "unavailable") return "text-[#ef929e]";
  if (status === "ready") return "text-[#72bfa2]";
  return "text-[#8996a8]";
}

function signedTone(value: unknown): "good" | "bad" | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value >= 0 ? "good" : "bad"
    : undefined;
}

function microUsd(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? formatUsdMicro(value) : "—";
}

function formatUsdMicro(value: number) {
  const usd = value / 1_000_000;
  const absolute = Math.abs(usd);
  const decimals = absolute >= 100 ? 0 : absolute >= 10 ? 1 : 2;
  return `${usd < 0 ? "−" : ""}$${absolute.toFixed(decimals)}`;
}

function formatRunway(value: number) {
  if (value >= 86_400_000) return `${(value / 86_400_000).toFixed(1)}D`;
  if (value >= 3_600_000) return `${(value / 3_600_000).toFixed(1)}H`;
  return `${Math.max(0, Math.floor(value / 60_000))}M`;
}

function parseTimestamp(value: string | undefined): number | null {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAge(value: number) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 60_000) return `${Math.floor(value / 1_000)}S`;
  if (value < 3_600_000) return `${Math.floor(value / 60_000)}M`;
  return `${(value / 3_600_000).toFixed(1)}H`;
}
