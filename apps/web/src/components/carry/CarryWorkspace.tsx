"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  createCarryPosition,
  executeCarryPositionEntry,
  getPrivateAgentPassport,
  listCarryPositions,
  observeCarryPosition,
  preflightCarryPair,
  requestCarryPositionExit,
} from "@/lib/private-account-client";
import {
  buildCarryRiskMandatePayload,
  carryRiskMandateAuthorization,
  defaultCarryRiskMandate,
} from "@/lib/carry-risk-mandate";
import { usePerpsTurnkey } from "@/lib/perps-turnkey-provider";
import { CORE_PERP_VENUES, isCarryExecutionVenue, type CarryExecutionVenue } from "@/lib/carry-venues";
import {
  CARRY_VENUE_LABELS as VENUE_LABELS,
  annualFundingBps,
  buildCandidates,
  builderModel,
  type CarryShadowResponse as ShadowResponse,
  type CarryShadowSnapshot as ShadowSnapshot,
  type CarryShadowStatus as ShadowStatus,
  type CarryVenueShadow as VenueShadow,
} from "@/lib/carry-market";
import { hasExactCarryFlatReconciliation } from "@/lib/carry-reconciliation";

export { buildCandidates, builderModel } from "@/lib/carry-market";

interface CarryRecord {
  record_version: number;
  position: {
    position_id: string;
    asset: string;
    long_venue_id: string;
    short_venue_id: string;
    target_notional_micro_usdc: number;
    status: string;
    next_actions: string[];
    terminal_reason: string | null;
    last_event_sequence: number;
    consecutive_exit_observations: number;
    risk_mandate: { exit_after_consecutive_observations: number };
  };
  opportunity: {
    live_creation_ready: boolean;
    projected_net_value_micro_usdc: number;
    break_even_ms: number;
    long_margin_runway_ms: number;
    short_margin_runway_ms: number;
    collateral_basis_mode?: string;
    collateral_basis_risk_micro_usdc?: number;
  };
  value_ledger: {
    status: string;
    modeled: { net_value_micro_usdc: number };
    realized: { net_value_micro_usdc: number; variance_from_modeled_micro_usdc: number };
    finalization_evidence: { gross_exposure_micro_usdc: number; open_order_count: number } | null;
  };
  latest_observation?: {
    as_of_ms: number;
    expected_net_value_bps: number;
    margin_runway_ms_by_venue: Record<string, number | null>;
  };
  final_reconciliation_evidence?: {
    gross_exposure_micro_usdc: number;
    open_order_count: number;
    account_state_checked: boolean;
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
  updated_at: string;
}

export function CarryWorkspace() {
  const perpsTurnkey = usePerpsTurnkey();
  const [data, setData] = useState<ShadowResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedAsset, setSelectedAsset] = useState("BTC");
  const [notional, setNotional] = useState("100");
  const [days, setDays] = useState("30");
  const [accountCheck, setAccountCheck] = useState<string | null>(null);
  const [pairProof, setPairProof] = useState<Record<string, unknown> | null>(null);
  const [checkingAccount, setCheckingAccount] = useState(false);
  const [positions, setPositions] = useState<CarryRecord[]>([]);
  const [positionsVisible, setPositionsVisible] = useState(false);
  const [positionAction, setPositionAction] = useState<string | null>(null);
  const monitoredPositionsRef = useRef<Array<{
    position_id: string;
    long_venue_id: CarryExecutionVenue;
    short_venue_id: CarryExecutionVenue;
  }>>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/v1/private-account/carry?assets=BTC,ETH,SOL", { cache: "no-store" });
      const body = await response.json() as ShadowResponse;
      if (!response.ok || body.error) throw new Error(body.error || "carry_shadow_unavailable");
      setData(body);
      setError(null);
    } catch {
      setError("Live carry comparison is temporarily unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const loadPositions = useCallback(async () => {
    try {
      const result = await listCarryPositions() as { ok?: boolean; records?: CarryRecord[] };
      if (result.ok === true && Array.isArray(result.records)) {
        setPositions(result.records);
        setPositionsVisible(true);
      }
    } catch {
      setPositionsVisible(false);
    }
  }, []);

  useEffect(() => {
    void loadPositions();
    const monitor = async () => {
      await Promise.allSettled(monitoredPositionsRef.current.map((item) => observeCarryPosition(item)));
      await loadPositions();
    };
    const timer = window.setInterval(() => void monitor(), 30_000);
    return () => window.clearInterval(timer);
  }, [loadPositions]);

  const monitoredPositions = useMemo(() => positions.filter((item) =>
    ["active", "rebalancing"].includes(item.position.status) &&
    isCarryExecutionVenue(item.position.long_venue_id) &&
    isCarryExecutionVenue(item.position.short_venue_id)
  ), [positions]);

  useEffect(() => {
    monitoredPositionsRef.current = monitoredPositions.map((item) => ({
      position_id: item.position.position_id,
      long_venue_id: item.position.long_venue_id as CarryExecutionVenue,
      short_venue_id: item.position.short_venue_id as CarryExecutionVenue,
    }));
  }, [monitoredPositions]);

  const candidates = useMemo(() => buildCandidates(data?.venues || []), [data]);
  const candidate = candidates.find((item) => item.asset === selectedAsset) || candidates[0] || null;
  const venueSummary = useMemo(() => summarizeVenues(data?.venues || []), [data]);
  const model = useMemo(() => candidate ? builderModel(candidate, notional, days) : null, [candidate, notional, days]);

  useEffect(() => {
    if (candidate && candidate.asset !== selectedAsset) setSelectedAsset(candidate.asset);
  }, [candidate, selectedAsset]);

  async function checkCandidateAccounts() {
    if (!candidate) return;
    const longVenue = candidate.long.venue_id;
    const shortVenue = candidate.short.venue_id;
    if (!isCarryExecutionVenue(longVenue) || !isCarryExecutionVenue(shortVenue)) {
      setAccountCheck("This pair includes a venue whose execution adapter is not yet qualified.");
      return;
    }
    setCheckingAccount(true);
    setAccountCheck(null);
    setPairProof(null);
    try {
      const result = await preflightCarryPair({
        asset: candidate.asset,
        long_venue_id: longVenue,
        short_venue_id: shortVenue,
        notional_usd: notional,
        horizon_days: days,
      }) as Record<string, unknown>;
      setPairProof(result);
      setAccountCheck(result.no_submit_ready === true
        ? result.live_creation_ready === true
          ? "Exact fees, capital, margin runway, and both order shapes passed without submission."
          : "Both account checks passed. Live creation remains locked until every venue has proven exact-quantity recovery."
        : "A venue still needs collateral, authorization, or a fresh connection.");
    } catch {
      setAccountCheck("The paired connection check failed. Reconnect the required trade-only wallets.");
    } finally {
      setCheckingAccount(false);
    }
  }

  async function saveQualifiedPosition() {
    if (!candidate || !pairProof || pairProof.live_creation_ready !== true) return;
    const opportunity = recordValue(pairProof.creation_opportunity);
    if (!opportunity) return;
    const id = crypto.randomUUID();
    const positionId = `carry:position:${id}`;
    const mandateId = `carry:mandate:${id}`;
    const notionalMicro = Math.round(Math.max(0, Number(notional) || 0) * 1_000_000);
    const riskMandate = defaultCarryRiskMandate();
    setPositionAction("Saving qualified Carry Position…");
    try {
      if (!perpsTurnkey.authenticated) throw new Error("carry_owner_auth_required");
      const [passportRaw, pair] = await Promise.all([
        getPrivateAgentPassport(),
        perpsTurnkey.ensureWalletPair(),
      ]);
      const passport = recordValue(passportRaw);
      const ownerCommitment = passport ? stringValue(passport.owner_commitment) : null;
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
      const result = await createCarryPosition({
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
      }) as { ok?: boolean; record?: CarryRecord };
      if (result.ok !== true || !result.record) throw new Error("carry_position_not_saved");
      setPositionAction("Carry Position saved. Its next action is shown below; no order was submitted.");
      await loadPositions();
    } catch {
      setPositionAction("The Carry Position was not saved because its proof is no longer current.");
    }
  }

  async function requestExit(item: CarryRecord) {
    setPositionAction(`Requesting reduce-only exit for ${item.position.asset}…`);
    try {
      await requestCarryPositionExit({
        position_id: item.position.position_id,
        sequence: item.position.last_event_sequence + 1,
        event_id: `carry:owner-exit:${crypto.randomUUID()}`,
      });
      setPositionAction("Exit mandate recorded. Risk increases remain disabled; reconciliation is required before completion.");
      await loadPositions();
    } catch {
      setPositionAction("Exit request was not accepted. Refresh the position before trying again.");
    }
  }

  async function executeEntry(item: CarryRecord) {
    setPositionAction(`Submitting the protected ${item.position.asset} pair…`);
    try {
      const result = await executeCarryPositionEntry(item.position.position_id) as { ok?: boolean; error?: string };
      if (result.ok !== true) throw new Error(result.error || "carry_entry_failed");
      setPositionAction("Both venue legs were submitted and reconciled as one Carry Position.");
      await loadPositions();
    } catch {
      setPositionAction("The pair was not opened. Ghola preserved the durable recovery state and will not retry ambiguity.");
      await loadPositions();
    }
  }

  return (
    <main className="min-h-screen bg-[#06080c] px-4 pb-20 pt-24 text-[#eef1f8] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1280px]">
        <header className="mb-8 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#5aa7ff]">Cross-venue carry</p>
            <h1 className="font-display text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">Earn the spread. Control both legs.</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-[#8f9aae]">
              Ghola compares equivalent perps, prices every cost, and manages the position as one risk unit.
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-[#7f8a9d]">
            <span className={`h-2 w-2 rounded-full ${error ? "bg-[#ff6b7a]" : loading ? "bg-[#f1c75b]" : "bg-[#56d6a0]"}`} />
            {error ? "Feed unavailable" : loading ? "Refreshing venues" : `Observed ${timeLabel(data?.observed_at)}`}
            <button type="button" onClick={() => void load()} className="rounded-md border border-[#233149] px-3 py-1.5 text-[#a9b7cc] hover:border-[#3a5275] hover:text-white">
              Refresh
            </button>
          </div>
        </header>

        <section className="mb-5 grid gap-3 sm:grid-cols-5" aria-label="Venue qualification">
          {venueSummary.map((venue) => (
            <div key={venue.id} className="term-panel rounded-lg px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">{VENUE_LABELS[venue.id] || venue.id}</span>
                <StatusPill status={venue.status} />
              </div>
              <p className="mt-2 text-xs text-[#718097]">{venue.detail}</p>
            </div>
          ))}
        </section>

        {error ? (
          <section className="term-panel rounded-xl p-8 text-center">
            <p className="text-lg font-medium">Carry data could not be verified.</p>
            <p className="mt-2 text-sm text-[#7f8a9d]">Ghola will not price or create a position from stale or missing venue data.</p>
          </section>
        ) : (
          <div className="grid gap-5 xl:grid-cols-[1.45fr_0.85fr]">
            <section className="term-panel overflow-hidden rounded-xl">
              <div className="border-b border-[#1c2940] px-5 py-4">
                <h2 className="text-base font-semibold">Carry scanner</h2>
                <p className="mt-1 text-sm text-[#718097]">Best gross funding spread by asset. Exact costs require both venue accounts.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="bg-[#080c13] text-xs uppercase tracking-[0.08em] text-[#657188]">
                    <tr>
                      <th className="px-5 py-3 font-medium">Asset</th>
                      <th className="px-5 py-3 font-medium">Long</th>
                      <th className="px-5 py-3 font-medium">Short</th>
                      <th className="px-5 py-3 text-right font-medium">Gross carry</th>
                      <th className="px-5 py-3 text-right font-medium">Costs</th>
                      <th className="px-5 py-3 text-right font-medium" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#142037]">
                    {candidates.map((item) => (
                      <tr key={item.asset} className={item.asset === candidate?.asset ? "bg-[#0b1320]" : "hover:bg-[#090e17]"}>
                        <td className="px-5 py-4 font-semibold">{item.asset}</td>
                        <td className="px-5 py-4"><VenueLeg snapshot={item.long} /></td>
                        <td className="px-5 py-4"><VenueLeg snapshot={item.short} /></td>
                        <td className="px-5 py-4 text-right font-mono text-[#72dfb2]">{formatPercent(item.grossAnnualBps / 100)} APY</td>
                        <td className="px-5 py-4 text-right text-xs text-[#8d99ad]">{item.exact ? "Exact" : "Needs fee tier"}</td>
                        <td className="px-5 py-4 text-right">
                          <button type="button" onClick={() => setSelectedAsset(item.asset)} className="rounded-md border border-[#2b4668] px-3 py-1.5 text-xs font-semibold text-[#a8d8ff] hover:bg-[#102038]">
                            Build
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!loading && candidates.length === 0 && (
                      <tr><td colSpan={6} className="px-5 py-10 text-center text-[#718097]">No fresh two-venue comparison is available.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="term-panel rounded-xl p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.12em] text-[#657188]">Carry builder</p>
                  <h2 className="mt-1 text-xl font-semibold">{candidate ? `${candidate.asset} delta-neutral` : "Choose a market"}</h2>
                </div>
                <span className="rounded-full border border-[#294566] bg-[#0c1726] px-2.5 py-1 text-xs text-[#9ecfff]">Proposal only</span>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3">
                <label className="text-xs text-[#7f8a9d]">Notional per leg
                  <div className="term-field mt-2 flex rounded-md px-3 py-2.5"><span className="mr-1 text-[#5f6d82]">$</span><input value={notional} onChange={(event) => setNotional(event.target.value)} inputMode="decimal" className="min-w-0 flex-1 bg-transparent font-mono text-sm text-white outline-none" /></div>
                </label>
                <label className="text-xs text-[#7f8a9d]">Holding period
                  <div className="term-field mt-2 flex rounded-md px-3 py-2.5"><input value={days} onChange={(event) => setDays(event.target.value)} inputMode="numeric" className="min-w-0 flex-1 bg-transparent font-mono text-sm text-white outline-none" /><span className="ml-1 text-[#5f6d82]">days</span></div>
                </label>
              </div>

              <div className="mt-5 space-y-3 border-y border-[#17243a] py-4 text-sm">
                <Metric label="Projected gross funding" value={model ? formatUsd(model.grossFundingUsd) : "—"} tone="good" />
                <Metric label="Round-trip fees + slippage" value={model?.costUsd == null ? "Needs exact fee tiers" : formatUsd(model.costUsd)} />
                <Metric label="Ghola trading capital (1×)" value={model ? formatUsd(model.requiredOpeningCapitalUsd) : "—"} />
                <Metric label="Venue minimum margin" value={model ? formatUsd(model.minimumCollateralUsd) : "—"} />
                <Metric label="Break-even" value={model?.breakEvenDays == null ? "Pending exact costs" : `${model.breakEvenDays.toFixed(1)} days`} />
                <Metric label="Expected net value" value={model?.netUsd == null ? "Pending exact costs" : formatUsd(model.netUsd)} tone={model?.netUsd != null && model.netUsd > 0 ? "good" : undefined} />
              </div>

              <div className="mt-5 rounded-lg border border-[#263851] bg-[#09111d] p-4">
                <p className="text-sm font-medium text-[#dbe6f5]">Risk mandate</p>
                <ul className="mt-2 space-y-1.5 text-xs leading-5 text-[#7f8a9d]">
                  <li>Exit after two confirmed funding flips</li>
                  <li>Freeze and reconcile on ambiguous submission</li>
                  <li>Owner approval required for transfers</li>
                  <li>Complete only when flat with zero open orders</li>
                </ul>
              </div>

              <Link href="/account?setup=carry" className="mt-5 block w-full rounded-md border border-[#315277] bg-[#0d1b2d] px-4 py-3 text-center text-sm font-semibold text-[#a8d8ff] hover:bg-[#11243c]">
                Connect both venues for account checks
              </Link>
              {candidate && [candidate.long.venue_id, candidate.short.venue_id].every(isCarryExecutionVenue) && (
                <button type="button" disabled={checkingAccount} onClick={() => void checkCandidateAccounts()} className="mt-2 w-full rounded-md border border-[#244f40] bg-[#0a211a] px-4 py-3 text-sm font-semibold text-[#72dfb2] disabled:opacity-50">
                  {checkingAccount ? "Checking both venues…" : "Run paired no-submit checks"}
                </button>
              )}
              {accountCheck && <p className="mt-3 text-center text-xs leading-5 text-[#8f9aae]">{accountCheck}</p>}
              {pairProof && <PairProofSummary proof={pairProof} />}
              {pairProof?.live_creation_ready === true && (
                <button type="button" onClick={() => void saveQualifiedPosition()} className="mt-2 w-full rounded-md border border-[#2d5d82] bg-[#10243a] px-4 py-3 text-sm font-semibold text-[#b7ddff]">
                  Save qualified Carry Position
                </button>
              )}
              {positionAction && <p className="mt-3 text-center text-xs leading-5 text-[#8f9aae]">{positionAction}</p>}
              <p className="mt-3 text-center text-xs text-[#59667b]">Scanning, checking, and saving never submit orders. Entry requires the separate action below.</p>
            </section>
          </div>
        )}

        {positionsVisible && (
          <CarryPositionsPanel records={positions} onEnter={(item) => void executeEntry(item)} onExit={(item) => void requestExit(item)} />
        )}
      </div>
    </main>
  );
}

function CarryPositionsPanel({ records, onEnter, onExit }: { records: CarryRecord[]; onEnter: (record: CarryRecord) => void; onExit: (record: CarryRecord) => void }) {
  return (
    <section className="term-panel mt-5 overflow-hidden rounded-xl" aria-label="Carry Positions">
      <div className="border-b border-[#1c2940] px-5 py-4">
        <h2 className="text-base font-semibold">Carry Positions</h2>
        <p className="mt-1 text-sm text-[#718097]">One position, both venues, one risk and value record.</p>
      </div>
      {records.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-[#718097]">No qualified Carry Position has been saved.</p>
      ) : (
        <div className="divide-y divide-[#142037]">
          {records.map((record) => {
            const position = record.position;
            const finalized = record.value_ledger.status === "finalized";
            const exactFlat = hasExactCarryFlatReconciliation(record.final_reconciliation_evidence, [
              position.long_venue_id,
              position.short_venue_id,
            ]);
            const currentRunways = record.latest_observation?.margin_runway_ms_by_venue;
            const longRunway = currentRunways?.[position.long_venue_id] ?? record.opportunity.long_margin_runway_ms;
            const shortRunway = currentRunways?.[position.short_venue_id] ?? record.opportunity.short_margin_runway_ms;
            const canExit = ["active", "rebalancing", "frozen"].includes(position.status);
            const canEnter = position.status === "draft" && record.opportunity.live_creation_ready === true;
            return (
              <article key={position.position_id} className="grid gap-5 px-5 py-5 lg:grid-cols-[1.15fr_1fr_1fr_auto] lg:items-center">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold">{position.asset} delta-neutral</h3>
                    <CarryStatus status={position.status} />
                  </div>
                  <p className="mt-1 text-xs text-[#718097]">
                    Long {VENUE_LABELS[position.long_venue_id] || position.long_venue_id} · Short {VENUE_LABELS[position.short_venue_id] || position.short_venue_id}
                  </p>
                  <p className="mt-1 font-mono text-xs text-[#8f9aae]">{formatUsd(position.target_notional_micro_usdc / 1_000_000)} per leg</p>
                </div>
                <div className="space-y-1.5 text-xs">
                  <PositionLine label="Next action" value={humanAction(position.next_actions[0])} />
                  <PositionLine label="Funding exit signal" value={`${position.consecutive_exit_observations}/${position.risk_mandate.exit_after_consecutive_observations}`} />
                  <PositionLine label="Current runway" value={`${VENUE_LABELS[position.long_venue_id] || position.long_venue_id} ${durationCompact(longRunway)} · ${VENUE_LABELS[position.short_venue_id] || position.short_venue_id} ${durationCompact(shortRunway)}`} />
                  <PositionLine label="Current net carry" value={record.latest_observation ? `${record.latest_observation.expected_net_value_bps} bps` : "Awaiting first observation"} />
                </div>
                <div className="space-y-1.5 text-xs">
                  <PositionLine label="Modeled net" value={microUsd(record.value_ledger.modeled.net_value_micro_usdc)} tone="good" />
                  <PositionLine label="Collateral basis stress" value={microUsd(record.opportunity.collateral_basis_risk_micro_usdc)} />
                  <PositionLine label={finalized ? "Realized net" : "Value evidence"} value={finalized ? microUsd(record.value_ledger.realized.net_value_micro_usdc) : "Pending exact costs"} />
                  <PositionLine label="Final proof" value={finalized
                    ? exactFlat ? "Flat · 0 orders · both venues verified" : "Venue proof incomplete"
                    : position.status === "reconciled"
                      ? exactFlat ? "Flat; costs pending evidence" : "Awaiting venue-specific flat proof"
                      : "Pending reconciliation"} />
                </div>
                <div>
                  {canEnter ? (
                    <button type="button" onClick={() => onEnter(record)} className="rounded-md border border-[#2d5d82] bg-[#10243a] px-3 py-2 text-xs font-semibold text-[#b7ddff]">
                      Execute protected pair
                    </button>
                  ) : canExit ? (
                    <button type="button" onClick={() => onExit(record)} className="rounded-md border border-[#6b3b45] bg-[#251116] px-3 py-2 text-xs font-semibold text-[#f09aa5]">
                      Request reduce-only exit
                    </button>
                  ) : (
                    <span className="text-xs text-[#637087]">{position.terminal_reason ? humanAction(position.terminal_reason) : "Monitoring"}</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CarryStatus({ status }: { status: string }) {
  const safe = ["active", "reconciled"].includes(status);
  const warning = ["opening", "draft", "rebalancing"].includes(status);
  const style = safe ? "border-[#245f49] bg-[#0c241c] text-[#72dfb2]" : warning ? "border-[#5a4924] bg-[#241d0c] text-[#e1c36b]" : "border-[#60303a] bg-[#251116] text-[#ee8190]";
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${style}`}>{status.replaceAll("_", " ")}</span>;
}

function PositionLine({ label, value, tone }: { label: string; value: string; tone?: "good" }) {
  return <div className="flex justify-between gap-4"><span className="text-[#718097]">{label}</span><span className={`text-right font-mono ${tone === "good" ? "text-[#72dfb2]" : "text-[#dbe3ef]"}`}>{value}</span></div>;
}

function PairProofSummary({ proof }: { proof: Record<string, unknown> }) {
  const opportunity = proof.economic_opportunity && typeof proof.economic_opportunity === "object"
    ? proof.economic_opportunity as Record<string, unknown>
    : {};
  const creation = proof.creation_opportunity && typeof proof.creation_opportunity === "object"
    ? proof.creation_opportunity as Record<string, unknown>
    : {};
  const reasons = Array.isArray(proof.qualification_reasons) ? proof.qualification_reasons.map(String) : [];
  const accounts = Array.isArray(proof.account_readiness)
    ? proof.account_readiness.map(recordValue).filter((account): account is Record<string, unknown> => account !== null)
    : [];
  return (
    <div className="mt-3 rounded-md border border-[#253851] bg-[#080f19] p-3 text-xs text-[#8f9aae]">
      <div className="flex justify-between gap-3"><span>Authenticated projected net</span><span className="font-mono text-[#dbe6f5]">{microUsd(opportunity.projected_net_value_micro_usdc)}</span></div>
      <div className="mt-1 flex justify-between gap-3"><span>Modeled break-even</span><span className="font-mono text-[#dbe6f5]">{durationDays(opportunity.break_even_ms)}</span></div>
      <div className="mt-1 flex justify-between gap-3"><span>Collateral basis stress</span><span className="font-mono text-[#dbe6f5]">{microUsd(opportunity.collateral_basis_risk_micro_usdc)}</span></div>
      <div className="mt-1 flex justify-between gap-3"><span>Collateral assets</span><span className="font-mono text-[#dbe6f5]">{textValue(opportunity.long_collateral_asset)} / {textValue(opportunity.short_collateral_asset)}</span></div>
      <div className="mt-1 flex justify-between gap-3"><span>Margin runway</span><span className="font-mono text-[#dbe6f5]">{durationCompact(creation.long_margin_runway_ms)} / {durationCompact(creation.short_margin_runway_ms)}</span></div>
      {accounts.map((account) => (
        <div key={textValue(account.venue_id)} className="mt-1 flex justify-between gap-3">
          <span>{textValue(account.venue_id)} opening capital</span>
          <span className="font-mono text-[#dbe6f5]">
            {microUsd(account.available_balance_micro_usdc)} / {microUsd(account.required_opening_collateral_micro_usdc)}
            {Number(account.opening_collateral_shortfall_micro_usdc) > 0
              ? ` · ${microUsd(account.opening_collateral_shortfall_micro_usdc)} owner shortfall`
              : " · ready"}
          </span>
        </div>
      ))}
      {proof.qualification_pilot_ready === true && <p className="mt-2 text-[#d5ae65]">Eligible for one separately confirmed qualification lifecycle; normal trading remains locked.</p>}
      {reasons.length > 0 && <p className="mt-2 text-[#d5ae65]">Locked: {reasons.join(", ")}</p>}
    </div>
  );
}

function microUsd(value: unknown) {
  return typeof value === "number" ? formatUsd(value / 1_000_000) : "—";
}

function durationDays(value: unknown) {
  return typeof value === "number" ? `${(value / 86_400_000).toFixed(1)} days` : "Not reached";
}

function durationCompact(value: unknown) {
  if (typeof value !== "number" || value < 0) return "—";
  if (value >= 86_400_000) return `${(value / 86_400_000).toFixed(1)}d`;
  return `${(value / 3_600_000).toFixed(1)}h`;
}

function textValue(value: unknown) {
  return typeof value === "string" && value ? value : "—";
}

function humanAction(value: unknown) {
  if (typeof value !== "string" || !value) return "None";
  const labels: Record<string, string> = {
    run_preflight: "Run protected preflight",
    submit_protected_multi_leg_entry: "Submit protected pair",
    monitor_carry_and_margin: "Monitor carry + margin",
    reconcile_only: "Reconcile only",
    reduce_only_close_both_legs: "Reduce-only close",
    cancel_open_orders: "Cancel open orders",
    reduce_only_close_observed_exposure: "Close observed exposure",
    reconciled_flat: "Flat and reconciled",
    owner_exit_requested: "Owner exit requested",
  };
  return labels[value] || value.replaceAll("_", " ");
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function summarizeVenues(venues: VenueShadow[]) {
  return CORE_PERP_VENUES.map((id) => {
    const venue = venues.find((item) => item.venue_id === id);
    const snapshots = venue?.snapshots || [];
    const status: ShadowStatus = !venue?.ok || snapshots.some((item) => item.status === "quarantined")
      ? "quarantined"
      : snapshots.length > 0 && snapshots.every((item) => item.status === "ready") ? "ready" : "degraded";
    const detail = status === "ready" ? "Exact public inputs" : status === "degraded" ? "Account pricing needed" : "Excluded from routing";
    return { id, status, detail };
  });
}

function StatusPill({ status }: { status: ShadowStatus }) {
  const style = status === "ready" ? "border-[#245f49] bg-[#0c241c] text-[#72dfb2]" : status === "degraded" ? "border-[#5a4924] bg-[#241d0c] text-[#e1c36b]" : "border-[#60303a] bg-[#251116] text-[#ee8190]";
  const label = status === "ready" ? "Ready" : status === "degraded" ? "Needs account" : "Quarantined";
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${style}`}>{label}</span>;
}

function VenueLeg({ snapshot }: { snapshot: ShadowSnapshot }) {
  return <div><p className="font-medium text-[#dce4ef]">{VENUE_LABELS[snapshot.venue_id] || snapshot.venue_id}</p><p className="mt-0.5 font-mono text-xs text-[#6f7d92]">{formatPercent(annualFundingBps(snapshot) / 100)} APY</p></div>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" }) {
  return <div className="flex items-center justify-between gap-4"><span className="text-[#7f8a9d]">{label}</span><span className={`text-right font-mono text-xs ${tone === "good" ? "text-[#72dfb2]" : "text-[#dbe3ef]"}`}>{value}</span></div>;
}

function formatPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)}%`;
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function timeLabel(value?: string) {
  if (!value) return "just now";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "just now";
}
