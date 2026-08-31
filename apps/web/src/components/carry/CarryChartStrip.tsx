"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ChevronDown, RefreshCw } from "lucide-react";
import {
  CARRY_VENUE_LABELS,
  applyCarryLivePatches,
  annualFundingBps,
  buildPairCandidates,
  carryCandidateAgeMs,
  carryFundingEvidenceForCandidate,
  carryMarketQualificationEvidence,
  carryRoutingAdvantage,
  carryRoutingAdvantageEvidence,
  rankCarryCandidatesByNet,
  type CarryCandidate,
  type CarryLiveMarketPatch,
  type PricedCarryCandidate,
  type CarryShadowResponse,
} from "@/lib/carry-market";
import {
  CARRY_UI_PUBLISH_INTERVAL_MS,
  carryLiveDescriptorKey,
  createCarryPatchPublisher,
  createCarryLiveMarketStream,
} from "@/lib/carry-live-market";
import { CARRY_SHADOW_ASSETS, isCarryExecutionVenue } from "@/lib/carry-venues";

const CarryTerminalBuilder = dynamic(
  () => import("./CarryTerminalBuilder").then((module) => module.CarryTerminalBuilder),
  { ssr: false },
);

const CARRY_ROUTE_DISPLAY_MAX_AGE_MS = 30_000;

export function CarryChartStrip({
  asset,
  defaultOpen = false,
  autoRunNoSubmit = false,
  preferredLongVenue,
  preferredShortVenue,
  hyperliquidLivePatch,
  onAutoRunNoSubmitConsumed,
  onAssetSelect,
}: {
  asset: string;
  defaultOpen?: boolean;
  autoRunNoSubmit?: boolean;
  preferredLongVenue?: string | null;
  preferredShortVenue?: string | null;
  hyperliquidLivePatch?: CarryLiveMarketPatch | null;
  onAutoRunNoSubmitConsumed?: () => void;
  onAssetSelect: (asset: string) => void;
}) {
  const [data, setData] = useState<CarryShadowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const [clock, setClock] = useState(() => Date.now());
  const [livePatches, setLivePatches] = useState<CarryLiveMarketPatch[]>([]);
  const [executionRouteKey, setExecutionRouteKey] = useState("");
  const loadedOnceRef = useRef(false);

  const load = useCallback(async () => {
    if (!loadedOnceRef.current) setLoading(true);
    try {
      const response = await fetch(`/v1/private-account/carry?assets=${CARRY_SHADOW_ASSETS.join(",")}`, { cache: "no-store" });
      const body = await response.json() as CarryShadowResponse;
      if (!response.ok || body.error) throw new Error(body.error || "carry_shadow_unavailable");
      setData(body);
      setError(false);
    } catch {
      setError(true);
    } finally {
      loadedOnceRef.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await load();
        if (!cancelled) schedule();
      }, document.hidden ? 60_000 : 15_000);
    };
    void load();
    schedule();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const venueData = useMemo(() => data?.venues ?? [], [data?.venues]);
  const descriptorKey = useMemo(() => carryLiveDescriptorKey(venueData), [venueData]);
  const venueDataRef = useRef(venueData);

  useEffect(() => {
    venueDataRef.current = venueData;
  }, [venueData]);

  useEffect(() => {
    if (!descriptorKey) return;
    const publisher = createCarryPatchPublisher({
      intervalMs: CARRY_UI_PUBLISH_INTERVAL_MS,
      onPublish: (patches) => startTransition(() => setLivePatches(patches)),
    });
    const stream = createCarryLiveMarketStream({
      venues: venueDataRef.current,
      onPatch: publisher.push,
      // Connection state is transport telemetry, not proof that a quote is
      // current. Only normalized, age-gated patches may change the rail.
      onStatus: () => undefined,
    });
    stream.start();
    return () => {
      stream.stop();
      publisher.stop();
      setLivePatches([]);
    };
  }, [descriptorKey]);

  const effectivePatches = useMemo(() => hyperliquidLivePatch
    ? [...livePatches, hyperliquidLivePatch]
    : livePatches, [hyperliquidLivePatch, livePatches]);
  const effectiveVenues = useMemo(() => applyCarryLivePatches(
    data?.venues || [],
    effectivePatches,
    clock,
  ), [clock, data, effectivePatches]);
  const pricedCandidates = useMemo(() => rankCarryCandidatesByNet(
    buildPairCandidates(effectiveVenues),
    10_000,
    24,
    clock,
  ), [clock, effectiveVenues]);
  const freshCandidates = useMemo(() => pricedCandidates.filter(({ candidate }) =>
    carryCandidateAgeMs(candidate, clock) <= CARRY_ROUTE_DISPLAY_MAX_AGE_MS
  ), [clock, pricedCandidates]);
  const executionCandidates = useMemo(() => freshCandidates.filter(({ candidate }) =>
    isCarryExecutionVenue(candidate.long.venue_id) && isCarryExecutionVenue(candidate.short.venue_id)
  ), [freshCandidates]);
  const observedCandidates = useMemo(() => bestRoutePerAsset(freshCandidates), [freshCandidates]);
  const selectedObserved = observedCandidates.find(({ candidate }) => candidate.asset === asset) || null;
  const assetExecutionCandidates = executionCandidates.filter(({ candidate }) => candidate.asset === asset);
  const preferredExecutionRouteKey = isCarryExecutionVenue(preferredLongVenue)
    && isCarryExecutionVenue(preferredShortVenue)
    && preferredLongVenue !== preferredShortVenue
    ? `${asset}:${preferredLongVenue}:${preferredShortVenue}`
    : "";
  const selectedExecution = assetExecutionCandidates.find(({ candidate }) => carryRouteKey(candidate) === executionRouteKey)
    || (preferredExecutionRouteKey
      ? assetExecutionCandidates.find(({ candidate }) => carryRouteKey(candidate) === preferredExecutionRouteKey)
      : assetExecutionCandidates[0])
    || null;
  const selected = preferredExecutionRouteKey
    ? selectedExecution
    : selectedExecution || selectedObserved;
  const routeMode = selectedExecution ? "execution" : selected ? "shadow" : "none";
  const routingAdvantage = carryRoutingAdvantage(selectedExecution, assetExecutionCandidates);
  const routingEvidence = carryRoutingAdvantageEvidence(data, selectedExecution, routingAdvantage);
  const selectedAgeMs = selected ? carryCandidateAgeMs(selected.candidate, clock) : Number.POSITIVE_INFINITY;
  const committedSelectedNet = routingEvidence.status === "committed" ? routingEvidence.selectedNet : null;
  const selectedHasPositiveNet = committedSelectedNet
    ? committedSelectedNet.dailyNetUsd > 0
    : selected ? routeHasPositiveNet(selected.quote) : false;
  const edgeEvidence = carryFundingEvidenceForCandidate(
    data,
    selected?.candidate || null,
  );
  const marketEvidence = carryMarketQualificationEvidence(data);
  const terminalReturn = `/trade?product=perps&venue=hyperliquid&market=${asset}-PERP&carry=open`;
  const setupHref = `/account?setup=carry&return_to=${encodeURIComponent(terminalReturn)}`;

  return (
    <section
      className="mb-2 overflow-hidden rounded-md border border-[#252f3d] bg-[#090d13]"
      aria-label="Cross-venue route intelligence"
      data-modeled-net-positive={selectedHasPositiveNet ? "true" : "false"}
      data-route-mode={routeMode}
      data-edge-evidence={edgeEvidence.status}
      data-market-evidence={marketEvidence.status}
      data-routing-evidence={routingEvidence.status}
      data-net-evidence={committedSelectedNet ? "committed" : "indicative"}
      data-cost-basis={selected?.quote.exactCosts ? "net" : "gross-only"}
      data-route-age-ms={Number.isFinite(selectedAgeMs) ? Math.round(selectedAgeMs) : undefined}
    >
      <div className="flex min-h-10 items-center gap-2 px-2.5 sm:px-3">
        <div className="grid min-w-0 flex-1 grid-cols-[7rem_5.5rem_minmax(12rem,1fr)_8.75rem_10rem_6.25rem_6.5rem] items-center gap-x-2 font-mono text-[10px] tabular-nums max-[1023px]:grid-cols-[7rem_5.5rem_minmax(0,1fr)] max-[639px]:grid-cols-[7rem_minmax(0,1fr)]">
          <span className="flex items-center gap-1.5 font-semibold tracking-[0.12em] text-[#78bdff]">
            XVENUE
            {routeMode !== "none" ? (
              <span className={routeMode === "execution"
                ? "rounded border border-[#285040] px-1 py-0.5 text-[8px] tracking-[0.08em] text-[#72bfa2]"
                : "rounded border border-[#4a4350] px-1 py-0.5 text-[8px] tracking-[0.08em] text-[#a69aae]"}
              >
                {routeMode === "execution" ? "EXEC" : "SHADOW"}
              </span>
            ) : null}
          </span>
          <span className="text-[#aeb9c7] max-[639px]:hidden">{asset}-PERP</span>

          {selected ? (
            <>
              <p className="truncate text-[#d7dde6]">
                <span className="text-[#657286]">L</span> {venueName(selected.candidate.long.venue_id).toUpperCase()}
                <span className="px-1.5 text-[#3f4b5c]">/</span>
                <span className="text-[#657286]">S</span> {venueName(selected.candidate.short.venue_id).toUpperCase()}
              </p>
              <p className="whitespace-nowrap max-[1023px]:hidden">
                <span className="mr-1.5 text-[#657286]">GROSS</span>
                <span className="font-semibold text-[#d7dde6]">
                  {formatBps(grossDailyBps(selected.candidate))}
                </span>
              </p>
              <p className="whitespace-nowrap max-[1023px]:hidden">
                <span
                  className="mr-1.5 text-[#657286]"
                  title={committedSelectedNet
                    ? routingEvidence.detail
                    : "Indicative point-in-time economics. Live entry requires durable funding evidence."}
                >
                  {committedSelectedNet ? "NET24H✓" : "NET24H*"}
                </span>
                <span className={selected.quote.exactCosts
                  ? selectedHasPositiveNet ? "font-semibold text-[#72dfb2]" : "font-semibold text-[#e27d89]"
                  : "font-semibold text-[#d9bd74]"}
                >
                  {committedSelectedNet
                    ? formatBps(committedSelectedNet.dailyNetBps)
                    : selected.quote.exactCosts ? formatBps(selectedDailyBps(selected.candidate, selected.quote)) : "—"}
                </span>
              </p>
              <p className="whitespace-nowrap text-[#7d899a] max-[1023px]:hidden">AGE {formatAge(selectedAgeMs)}</p>
              <p
                className={`whitespace-nowrap max-[1023px]:hidden ${edgeEvidenceTone(edgeEvidence.status)}`}
                title={edgeEvidence.detail}
              >
                EVID {edgeEvidence.value}
              </p>
            </>
          ) : (
            <>
              <p className={error ? "truncate text-[#e27d89]" : "truncate text-[#8e9bad]"}>
                {error
                  ? "FEED UNAVAILABLE"
                  : loading
                    ? "ROUTE —"
                    : "NO FRESH ROUTE"}
              </p>
              <p className="whitespace-nowrap text-[#7d899a] max-[1023px]:hidden">GROSS —</p>
              <p className="whitespace-nowrap text-[#7d899a] max-[1023px]:hidden">NET24H* —</p>
              <p className="whitespace-nowrap text-[#7d899a] max-[1023px]:hidden">AGE —</p>
              <p className="whitespace-nowrap text-[#7d899a] max-[1023px]:hidden">EVID —</p>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh cross-venue routes"
            className="grid h-7 w-7 place-items-center rounded text-[#657286] hover:bg-white/5 hover:text-white disabled:opacity-40"
          >
            <RefreshCw className={loading ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
          </button>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="inline-flex h-7 items-center gap-1 rounded px-1.5 font-mono text-[10px] font-semibold tracking-[0.08em] text-[#8fbae0] hover:bg-[#0d1622]"
          >
            ROUTES
            <ChevronDown className={open ? "h-3 w-3 rotate-180 transition-transform" : "h-3 w-3 transition-transform"} />
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-[#1d2733] px-2.5 py-2 sm:px-3">
          <div className="mb-1.5 flex min-h-5 items-center gap-2 font-mono text-[9px] tabular-nums">
            <span className="tracking-[0.08em] text-[#657286]">MKT</span>
            <span className={`font-semibold ${marketEvidenceTone(marketEvidence.status)}`} title={marketEvidence.detail}>
              {marketEvidence.value}
            </span>
            <span className="truncate text-[#657286]">{marketEvidence.detail}</span>
            <span
              className={`ml-auto shrink-0 font-semibold ${routingAdvantageEvidenceTone(routingEvidence)}`}
              title={routingEvidence.detail}
            >
              {routingEvidence.label} {formatRoutingAdvantage(routingEvidence.advantage.dailyNetAdvantageBps)}
            </span>
          </div>
          {observedCandidates.length > 0 ? (
            <div className="grid gap-1.5 lg:grid-cols-3">
              {observedCandidates.slice(0, 3).map(({ candidate, quote }) => (
                <button
                  key={candidate.asset}
                  type="button"
                  onClick={() => onAssetSelect(candidate.asset)}
                  className={candidate.asset === asset
                    ? "rounded border border-[#35618d] bg-[#102033] px-2.5 py-2 text-left"
                    : "rounded border border-[#202a37] bg-[#080b10] px-2.5 py-2 text-left hover:border-[#35465c]"}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold text-white">{candidate.asset}</span>
                    <span className={routeHasPositiveNet(quote)
                      ? "font-mono text-[11px] font-semibold text-[#72dfb2]"
                      : quote.exactCosts
                        ? "font-mono text-[11px] font-semibold text-[#e27d89]"
                        : "font-mono text-[11px] font-semibold text-[#d9bd74]"}
                    >
                      {formatCarryValue(candidate, quote)}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-[10px] text-[#718096]">
                    Long {venueName(candidate.long.venue_id)} {formatFundingApr(candidate.long)} · Short {venueName(candidate.short.venue_id)} {formatFundingApr(candidate.short)}
                    {!quote.exactCosts
                      ? " · exact costs required"
                      : routeHasPositiveNet(quote)
                        ? ` · indicative net · ${carryFundingEvidenceForCandidate(data, candidate).detail}`
                        : " · no net edge"}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex min-h-8 items-center gap-3 text-[11px]">
              <p className="truncate text-[#8995a7]">No fresh cross-venue quote pair · stale and quarantined markets are excluded.</p>
              <Link
                href={setupHref}
                className="shrink-0 rounded border border-[#2b435e] px-2 py-1 font-mono text-[9px] font-semibold tracking-[0.06em] text-[#8fbae0] hover:bg-[#0d1622]"
              >
                SET UP CARRY
              </Link>
            </div>
          )}
          {selectedExecution ? (
            <>
              {assetExecutionCandidates.length > 1 ? (
                <label className="mt-2 flex items-center justify-end gap-2 font-mono text-[9px] text-[#657286]">
                  EXEC ROUTE
                  <select
                    aria-label="Carry execution route"
                    value={carryRouteKey(selectedExecution.candidate)}
                    onChange={(event) => setExecutionRouteKey(event.target.value)}
                    className="max-w-[18rem] rounded border border-[#202a37] bg-[#070a0f] px-2 py-1 text-[10px] text-[#b8c3d1] outline-none focus:border-[#35618d]"
                  >
                    {assetExecutionCandidates.map(({ candidate, daily_value_bps: dailyValueBps }) => (
                      <option key={carryRouteKey(candidate)} value={carryRouteKey(candidate)}>
                        L {venueName(candidate.long.venue_id)} / S {venueName(candidate.short.venue_id)} · {formatBps(dailyValueBps)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <CarryTerminalBuilder
                candidate={selectedExecution.candidate}
                autoRunNoSubmit={autoRunNoSubmit}
                onAutoRunNoSubmitConsumed={onAutoRunNoSubmitConsumed}
              />
            </>
          ) : preferredExecutionRouteKey && assetExecutionCandidates.length > 0 ? (
            <div className="mt-2 flex min-h-8 items-center justify-between gap-3 rounded border border-[#4b3840] bg-[#160d11] px-2.5 text-[10px] text-[#d6959f]">
              <span>SELECTED ROUTE STALE OR UNAVAILABLE · NO CHECK STARTED</span>
              <button
                type="button"
                onClick={() => setExecutionRouteKey(carryRouteKey(assetExecutionCandidates[0].candidate))}
                className="shrink-0 rounded border border-[#684b55] px-2 py-1 font-mono font-semibold text-[#efb0ba] hover:bg-white/5"
              >
                USE CURRENT QUALIFIED ROUTE
              </button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function venueName(venue: string) {
  return CARRY_VENUE_LABELS[venue] || venue;
}

function formatFundingApr(snapshot: CarryCandidate["long"]) {
  const value = annualFundingBps(snapshot) / 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)}% APR`;
}

function formatCarryValue(candidate: CarryCandidate, quote: PricedCarryCandidate["quote"]) {
  const gross = `GROSS ${formatBps(grossDailyBps(candidate))}`;
  const net = quote.exactCosts ? formatBps(selectedDailyBps(candidate, quote)) : "—";
  return `${gross} · NET24H* ${net}`;
}

function selectedDailyBps(candidate: CarryCandidate, quote: PricedCarryCandidate["quote"] | null) {
  if (quote?.exactCosts && quote.expectedNetDailyUsd != null && quote.notionalUsd > 0) {
    return quote.expectedNetDailyUsd / quote.notionalUsd * 10_000;
  }
  return grossDailyBps(candidate);
}

function grossDailyBps(candidate: CarryCandidate) {
  return candidate.grossAnnualBps / 365;
}

function routeHasPositiveNet(quote: PricedCarryCandidate["quote"]) {
  return quote.exactCosts && quote.expectedNetUsd != null && quote.expectedNetUsd > 0;
}

function bestRoutePerAsset(candidates: PricedCarryCandidate[]) {
  const best = new Map<string, PricedCarryCandidate>();
  for (const item of candidates) {
    if (!best.has(item.candidate.asset)) best.set(item.candidate.asset, item);
  }
  return [...best.values()];
}

function carryRouteKey(candidate: CarryCandidate) {
  return `${candidate.asset}:${candidate.long.venue_id}:${candidate.short.venue_id}`;
}

function formatBps(value: number) {
  const absolute = Math.abs(value);
  const decimals = absolute >= 100 ? 0 : absolute >= 10 ? 1 : 2;
  return `${value >= 0 ? "+" : "−"}${absolute.toFixed(decimals)}BP/D`;
}

function formatAge(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1_000) return `${Math.round(value)}MS`;
  return `${Math.round(value / 1_000)}S`;
}

function formatRoutingAdvantage(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return formatBps(value);
}

function routingAdvantageTone(status: ReturnType<typeof carryRoutingAdvantage>["status"]) {
  if (status === "advantaged") return "text-[#72dfb2]";
  if (status === "disadvantaged") return "text-[#e27d89]";
  return status === "equal" ? "text-[#aeb9c7]" : "text-[#657286]";
}

function routingAdvantageEvidenceTone(
  evidence: ReturnType<typeof carryRoutingAdvantageEvidence>,
) {
  if (evidence.status === "rejected") return "text-[#e27d89]";
  return routingAdvantageTone(evidence.advantage.status);
}

function edgeEvidenceTone(status: ReturnType<typeof carryFundingEvidenceForCandidate>["status"]) {
  if (status === "durable") return "text-[#72dfb2]";
  if (status === "rejected") return "text-[#e27d89]";
  if (status === "observing") return "text-[#d9bd74]";
  return "text-[#7d899a]";
}

function marketEvidenceTone(status: ReturnType<typeof carryMarketQualificationEvidence>["status"]) {
  if (status === "ready") return "text-[#72dfb2]";
  if (status === "rejected") return "text-[#e27d89]";
  return "text-[#d9bd74]";
}
