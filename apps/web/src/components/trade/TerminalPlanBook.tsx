"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deriveTerminalPlanEconomics,
  deriveTerminalPlanRestoreDecision,
  emptyTerminalPlanBookStore,
  inspectTerminalPlanBookStore,
  mergeTerminalPlanBookStores,
  removeTerminalPlanSnapshot,
  resetTerminalPlanBookStore,
  serializeTerminalPlanBookStore,
  TERMINAL_PLAN_BOOK_IDENTITY_LIMIT,
  TERMINAL_PLAN_BOOK_INVALIDATION_NOTE_LIMIT,
  TERMINAL_PLAN_BOOK_NAME_LIMIT,
  TERMINAL_PLAN_BOOK_THESIS_LIMIT,
  terminalPlanBookClockNow,
  terminalPlanBookStorageKey,
  terminalPlanBookStoresEqual,
  terminalPlansForIdentity,
  terminalPlansOutsideIdentity,
  upsertTerminalPlanSnapshot,
  type TerminalPlanBookIdentity,
  type TerminalPlanBookInspection,
  type TerminalPlanDraft,
  type TerminalPlanSetup,
  type TerminalPlanSnapshot,
} from "@/lib/terminal-plan-book";
import type { TerminalSavedPlanInventoryItem } from "@/lib/terminal-alerts";

export interface TerminalPlanBookProps {
  persistenceScope: string | null;
  identity: TerminalPlanBookIdentity;
  getCurrentReferencePrice: () => number | null;
  onCapture: () => TerminalPlanDraft | null;
  onRestore: (plan: TerminalPlanSnapshot) => boolean;
  onInspectIdentity?: (identity: TerminalPlanBookIdentity) => boolean;
  onWatch?: (plan: TerminalPlanSnapshot) => boolean;
  onUnwatch?: (plan: TerminalPlanSnapshot) => boolean;
  onInventoryChange?: (inventory: readonly TerminalSavedPlanInventoryItem[] | null) => void;
  watchedPlanIds?: readonly string[];
}

export const TerminalPlanBook = memo(function TerminalPlanBook({
  persistenceScope,
  identity,
  getCurrentReferencePrice,
  onCapture,
  onRestore,
  onInspectIdentity,
  onWatch,
  onUnwatch,
  onInventoryChange,
  watchedPlanIds = [],
}: TerminalPlanBookProps) {
  const storageKey = terminalPlanBookStorageKey(persistenceScope);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [loadedStorageKey, setLoadedStorageKey] = useState<string | null>(null);
  const [inspection, setInspection] = useState<TerminalPlanBookInspection>(() => ({
    status: "absent",
    store: emptyTerminalPlanBookStore(),
    raw: null,
  }));
  const inspectionRef = useRef(inspection);
  const [name, setName] = useState("");
  const [setup, setSetup] = useState<TerminalPlanSetup>("pullback");
  const [thesis, setThesis] = useState("");
  const [invalidationNote, setInvalidationNote] = useState("");
  const [message, setMessage] = useState("");
  const [observedAtMs, setObservedAtMs] = useState(() => Date.now());
  const [observedReferencePrice, setObservedReferencePrice] = useState<number | null>(null);
  const updateInspection = useCallback((next: TerminalPlanBookInspection) => {
    inspectionRef.current = next;
    setInspection(next);
  }, []);

  useEffect(() => {
    if (!storageKey) return;
    const activeStorageKey = storageKey;
    function reconcileStorage(event: StorageEvent) {
      if (event.key !== activeStorageKey || (event.storageArea && event.storageArea !== window.localStorage)) return;
      const incoming = inspectTerminalPlanBookStore(event.newValue);
      setLoadedStorageKey(activeStorageKey);
      if (incoming.status === "blocked") {
        updateInspection(incoming);
        setMessage("Plan book changed in another tab and is now locked");
        return;
      }
      const current = inspectionRef.current;
      const merged = current.status === "blocked"
        ? incoming.store
        : mergeTerminalPlanBookStores(current.store, incoming.store);
      const raw = serializeTerminalPlanBookStore(merged);
      if (!terminalPlanBookStoresEqual(merged, incoming.store)) {
        try {
          window.localStorage.setItem(activeStorageKey, raw);
        } catch {
          updateInspection({ status: "blocked", store: null, raw: event.newValue ?? "storage_unavailable" });
          return;
        }
      }
      updateInspection({ status: "ready", store: merged, raw });
      setObservedAtMs(Date.now());
      setObservedReferencePrice(getCurrentReferencePrice());
      setMessage("Plan book synchronized from another tab");
    }
    window.addEventListener("storage", reconcileStorage);
    return () => window.removeEventListener("storage", reconcileStorage);
  }, [getCurrentReferencePrice, storageKey, updateInspection]);

  const loadStorage = useCallback(() => {
    if (!storageKey || loadedStorageKey === storageKey) return;
    try {
      updateInspection(inspectTerminalPlanBookStore(window.localStorage.getItem(storageKey)));
    } catch {
      updateInspection({ status: "blocked", store: null, raw: "storage_unavailable" });
    }
    setLoadedStorageKey(storageKey);
    setObservedAtMs(Date.now());
    setObservedReferencePrice(getCurrentReferencePrice());
  }, [getCurrentReferencePrice, loadedStorageKey, storageKey, updateInspection]);

  function persist(next: Exclude<TerminalPlanBookInspection["store"], null>) {
    if (!storageKey) throw new Error("terminal_plan_book_scope_unavailable");
    const current = inspectTerminalPlanBookStore(window.localStorage.getItem(storageKey));
    if (current.status === "blocked") {
      updateInspection(current);
      throw new Error("terminal_plan_book_storage_blocked");
    }
    const merged = mergeTerminalPlanBookStores(current.store, next);
    const raw = serializeTerminalPlanBookStore(merged);
    window.localStorage.setItem(storageKey, raw);
    updateInspection({ status: "ready", store: merged, raw });
    setLoadedStorageKey(storageKey);
    setObservedAtMs(Date.now());
    setObservedReferencePrice(getCurrentReferencePrice());
    return merged;
  }

  function save() {
    if (inspection.status === "blocked") return;
    const draft = onCapture();
    if (!draft) {
      setMessage("Save blocked: a certified reference and valid entry/invalidation plan are required");
      return;
    }
    try {
      const next = upsertTerminalPlanSnapshot(inspection.store, {
        ...draft,
        id: createPlanId(),
        name,
        setup,
        thesis,
        invalidationNote,
      });
      persist(next);
      setObservedReferencePrice(draft.certifiedReferencePrice);
      setName("");
      setThesis("");
      setInvalidationNote("");
      setMessage("Plan and decision context saved locally; no order previewed or submitted");
    } catch (error) {
      setMessage(error instanceof Error && error.message === "terminal_plan_book_limit"
        ? `Plan limit reached (${TERMINAL_PLAN_BOOK_IDENTITY_LIMIT} for this instrument)`
        : "Enter a valid name, thesis, invalidation note, and complete plan");
    }
  }

  function restore(plan: TerminalPlanSnapshot) {
    const nowMs = terminalPlanBookClockNow();
    const currentReferencePrice = getCurrentReferencePrice();
    const decision = deriveTerminalPlanRestoreDecision({ plan, identity, currentReferencePrice, nowMs });
    setObservedAtMs(nowMs);
    setObservedReferencePrice(currentReferencePrice);
    if (decision.status === "blocked") {
      setMessage(restoreBlockerLabel(decision.blocker));
      return;
    }
    if (decision.status === "confirm" && !window.confirm(`Restore “${plan.name}”? Market drift is ${decision.driftBps.toFixed(1)} bp and the snapshot is ${formatAge(decision.ageMs)} old. This only stages the ticket.`)) return;
    if (!onRestore(plan)) {
      setMessage("Restore blocked: market certification or execution state changed");
      return;
    }
    setMessage(`${plan.name} restored to the ticket; execution bindings cleared and no order submitted`);
    if (detailsRef.current) detailsRef.current.open = false;
  }

  function remove(plan: TerminalPlanSnapshot) {
    if (inspection.status === "blocked" || !window.confirm(`Delete local plan “${plan.name}”? Active watches will be removed; triggered alert history remains as an audit trail.`)) return;
    try {
      const persisted = persist(removeTerminalPlanSnapshot(inspection.store, plan.id));
      setMessage(persisted.plans.some((candidate) => candidate.id === plan.id)
        ? `${plan.name} has a newer concurrent revision and was preserved`
        : `${plan.name} deleted`);
    } catch {
      setMessage("Plan deletion failed");
    }
  }

  function watch(plan: TerminalPlanSnapshot) {
    if (!onWatch?.(plan)) {
      setMessage("Plan watch blocked: current certified instrument context is unavailable");
      return;
    }
    setMessage(`${plan.name} sent to local alerts for atomic entry, target, and invalidation monitoring; no order submitted`);
  }

  function unwatch(plan: TerminalPlanSnapshot) {
    if (!onUnwatch?.(plan)) {
      setMessage("Plan unwatch blocked: alert storage or instrument context is unavailable");
      return;
    }
    setMessage(`${plan.name} monitoring removal requested; triggered history remains as an audit trail`);
  }

  function resetBlockedStorage() {
    if (!storageKey || inspection.status !== "blocked" || !window.confirm("Reset unreadable local plan-book storage? Existing bytes cannot be recovered after this.")) return;
    try {
      const store = resetTerminalPlanBookStore();
      const raw = serializeTerminalPlanBookStore(store);
      window.localStorage.setItem(storageKey, raw);
      updateInspection({ status: "ready", store, raw });
      setLoadedStorageKey(storageKey);
      setMessage("Plan-book storage reset");
    } catch {
      setMessage("Plan-book storage remains unavailable");
    }
  }

  const storageReady = loadedStorageKey === storageKey;
  const plans = useMemo(() => (
    storageReady && inspection.status !== "blocked"
      ? terminalPlansForIdentity(inspection.store, identity)
      : []
  ), [identity, inspection, storageReady]);
  const otherPlans = useMemo(() => (
    storageReady && inspection.status !== "blocked"
      ? terminalPlansOutsideIdentity(inspection.store, identity)
      : []
  ), [identity, inspection, storageReady]);
  const planInventory = useMemo<readonly TerminalSavedPlanInventoryItem[] | null>(() => (
    storageReady && inspection.status !== "blocked"
      ? inspection.store.plans.map((plan) => ({ planId: plan.id, instrument: plan.identity.product }))
      : null
  ), [inspection, storageReady]);
  const watchedPlanIdSet = useMemo(() => new Set(watchedPlanIds), [watchedPlanIds]);
  useEffect(() => {
    if (!onInventoryChange) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) onInventoryChange(planInventory);
    });
    return () => {
      cancelled = true;
    };
  }, [onInventoryChange, planInventory]);
  function refreshReview() {
    setObservedAtMs(terminalPlanBookClockNow());
    setObservedReferencePrice(getCurrentReferencePrice());
    setMessage("Plan review refreshed from the latest certified selected-market price");
  }
  function inspectOtherMarket(plan: TerminalPlanSnapshot) {
    if (!onInspectIdentity?.(plan.identity)) {
      setMessage("Market navigation blocked: saved plan identity is unsupported or execution is busy");
      return;
    }
    setMessage(`Loading ${plan.identity.product}; awaiting fresh market certification before restore`);
    if (detailsRef.current) detailsRef.current.open = false;
  }

  return (
    <details
      ref={detailsRef}
      id="terminal-plan-book"
      className="mt-2 rounded-md border border-[#172235] bg-[#080d15]"
      onToggle={(event) => {
        if (event.currentTarget.open) {
          setObservedAtMs(Date.now());
          setObservedReferencePrice(getCurrentReferencePrice());
          loadStorage();
        }
      }}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-2.5 py-2 marker:hidden">
        <span>
          <span className="block text-[8px] font-semibold uppercase tracking-[0.14em] text-[#7d8ba5]">Local plan book</span>
          <span className="mt-0.5 block text-[8px] text-[#66738c]">Instrument-bound snapshots · no auto-restore</span>
        </span>
        <span className="font-mono text-[8px] text-sky-200">{plans.length}/{TERMINAL_PLAN_BOOK_IDENTITY_LIMIT} · {plans.length + otherPlans.length} total</span>
      </summary>
      <div className="border-t border-[#141d2e] px-2.5 py-2.5">
        {!storageKey ? (
          <p role="status" className="text-[9px] leading-4 text-amber-200">Plan book waits for a verified local persistence scope.</p>
        ) : inspection.status === "blocked" ? (
          <div role="alert" className="rounded border border-rose-300/25 bg-rose-300/[0.04] p-2 text-[9px] leading-4 text-rose-200">
            Existing plan-book storage is unreadable and preserved. Saving, loading, and deletion are locked.
            <button type="button" onClick={resetBlockedStorage} className="term-chip mt-2 block h-7 px-2 text-[8px]">Reset storage</button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
              <label className="sr-only" htmlFor="terminal-plan-book-name">Plan name</label>
              <input
                id="terminal-plan-book-name"
                value={name}
                maxLength={TERMINAL_PLAN_BOOK_NAME_LIMIT}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    save();
                  }
                }}
                placeholder="Pullback A"
                className="trade-field h-8 min-w-0 rounded px-2 text-[9px] text-[#dce6f4] outline-none"
              />
              <button type="button" disabled={!name.trim() || !thesis.trim() || !invalidationNote.trim()} onClick={save} className="term-chip h-8 px-2 text-[8px] disabled:cursor-not-allowed disabled:opacity-40">Save plan</button>
            </div>
            <div className="mt-1.5 grid gap-1.5 sm:grid-cols-[8rem_minmax(0,1fr)]">
              <div>
                <label className="sr-only" htmlFor="terminal-plan-book-setup">Setup</label>
                <select id="terminal-plan-book-setup" value={setup} onChange={(event) => setSetup(event.target.value as TerminalPlanSetup)} className="trade-field h-8 w-full rounded px-2 text-[9px] text-[#dce6f4] outline-none">
                  <option value="breakout">Breakout</option>
                  <option value="pullback">Pullback</option>
                  <option value="reversal">Reversal</option>
                  <option value="range">Range</option>
                  <option value="event">Event</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <label className="min-w-0">
                <span className="sr-only">Trade thesis</span>
                <input value={thesis} maxLength={TERMINAL_PLAN_BOOK_THESIS_LIMIT} onChange={(event) => setThesis(event.target.value)} placeholder="Thesis: why this trade should work" className="trade-field h-8 w-full rounded px-2 text-[9px] text-[#dce6f4] outline-none" />
              </label>
            </div>
            <label className="mt-1.5 block">
              <span className="sr-only">Invalidation rationale</span>
              <input value={invalidationNote} maxLength={TERMINAL_PLAN_BOOK_INVALIDATION_NOTE_LIMIT} onChange={(event) => setInvalidationNote(event.target.value)} placeholder="Invalidated if: what evidence disproves the thesis" className="trade-field h-8 w-full rounded px-2 text-[9px] text-[#dce6f4] outline-none" />
            </label>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[8px] uppercase tracking-[0.1em] text-[#66738c]">Current instrument</span>
              <button type="button" onClick={refreshReview} className="term-chip h-7 px-2 text-[8px]">Refresh review</button>
            </div>
            <div className="mt-2 grid max-h-52 gap-1.5 overflow-y-auto" aria-label="Saved plans for current instrument">
              {plans.length === 0 ? <p className="py-1 text-[8px] text-[#66738c]">No plans saved for this exact venue, network, product, and interval.</p> : null}
              {plans.map((plan) => {
                const decision = deriveTerminalPlanRestoreDecision({ plan, identity, currentReferencePrice: observedReferencePrice, nowMs: observedAtMs });
                const economics = deriveTerminalPlanEconomics(plan);
                const target = economics?.targetPrice ?? decision.targetPrice;
                const watched = watchedPlanIdSet.has(plan.id);
                return (
                  <article key={plan.id} className="rounded border border-[#182234] bg-[#0a101a] px-2 py-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h4 className="truncate text-[9px] font-medium text-[#dce6f4]">{plan.name}</h4>
                        <p className="mt-0.5 truncate text-[8px] text-sky-200" title={plan.thesis ?? undefined}>{plan.setup ? `${setupLabel(plan.setup)} · ${plan.thesis}` : "Legacy snapshot · no thesis recorded"}</p>
                        {plan.invalidationNote ? <p className="mt-0.5 truncate text-[8px] text-amber-100" title={plan.invalidationNote}>Invalidated if · {plan.invalidationNote}</p> : null}
                        <p className="mt-0.5 truncate font-mono text-[8px] text-[#8e9aaf]">
                          {plan.side.toUpperCase()} {formatPrice(plan.entryPrice)} · inv {formatPrice(plan.invalidationPrice)} · {plan.targetRewardMultiple.toFixed(1)}R {formatPrice(target)}
                        </p>
                        <p className={`mt-0.5 font-mono text-[8px] ${decisionTone(decision.status)}`}>
                          {decision.status === "blocked" ? restoreBlockerLabel(decision.blocker) : `${formatAge(decision.ageMs)} old · ${decision.driftBps.toFixed(1)} bp drift · ${decision.status === "confirm" ? "review" : "current"}`}
                        </p>
                        {economics ? (
                          <p className={`mt-0.5 font-mono text-[8px] ${economics.withinBudget ? "text-emerald-300" : "text-rose-300"}`}>
                            Risk {formatUsd(economics.modeledLossUsd)} / {formatUsd(plan.riskBudgetUsd)} · target +{formatUsd(economics.targetProfitUsd)} · {economics.netRewardRisk.toFixed(2)}R · {economics.budgetUtilizationPct.toFixed(0)}%
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        {onWatch ? (
                          <button
                            type="button"
                            aria-pressed={watched}
                            onClick={() => watched ? unwatch(plan) : watch(plan)}
                            className={watched ? "term-chip h-7 border-emerald-300/40 px-2 text-[8px] text-emerald-200" : "term-chip h-7 px-2 text-[8px]"}
                          >
                            {watched ? "Unwatch" : "Watch"}
                          </button>
                        ) : null}
                        <button type="button" disabled={decision.status === "blocked"} onClick={() => restore(plan)} className="term-chip h-7 px-2 text-[8px] disabled:cursor-not-allowed disabled:opacity-40">Restore</button>
                        <button type="button" aria-label={`Delete ${plan.name}`} onClick={() => remove(plan)} className="rounded px-1 text-[10px] text-[#7f8da7] hover:text-rose-200">×</button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
            {otherPlans.length > 0 ? (
              <section className="mt-2 border-t border-[#141d2e] pt-2" aria-labelledby="terminal-plan-book-other-heading">
                <div className="flex items-center justify-between gap-2">
                  <h4 id="terminal-plan-book-other-heading" className="text-[8px] font-semibold uppercase tracking-[0.1em] text-[#66738c]">Other markets</h4>
                  <span className="font-mono text-[8px] text-[#66738c]">{otherPlans.length}</span>
                </div>
                <div className="mt-1.5 grid max-h-28 gap-1 overflow-y-auto">
                  {otherPlans.map((plan) => (
                    <OtherMarketPlan key={plan.id} plan={plan} onInspect={onInspectIdentity ? inspectOtherMarket : null} />
                  ))}
                </div>
                <p className="mt-1 text-[8px] leading-3 text-[#566278]">Inspect only changes market context and clears bindings; it never restores the saved plan automatically.</p>
              </section>
            ) : null}
          </>
        )}
        <p aria-live="polite" className="mt-2 min-h-4 text-[8px] leading-3.5 text-amber-100">{message}</p>
        <p className="text-[8px] leading-3.5 text-[#566278]">Device-local decision journal. Risk includes invalidation distance plus staged slippage; target profit subtracts staged slippage. Restore requires this exact market plus a certified current price, clears bindings, and never submits.</p>
      </div>
    </details>
  );
});

function createPlanId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID().replaceAll("-", "");
  return `plan${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function restoreBlockerLabel(blocker: Extract<ReturnType<typeof deriveTerminalPlanRestoreDecision>, { status: "blocked" }>["blocker"]) {
  if (blocker === "identity_mismatch") return "Exact market identity mismatch";
  if (blocker === "reference_unavailable") return "Certified current price unavailable";
  if (blocker === "snapshot_future") return "Snapshot time is in the future";
  if (blocker === "snapshot_expired") return "Snapshot is older than 30 days";
  if (blocker === "market_drift_excessive") return "Market drift exceeds 50%";
  return "Saved plan failed validation";
}

function decisionTone(status: ReturnType<typeof deriveTerminalPlanRestoreDecision>["status"]) {
  if (status === "ready") return "text-emerald-300";
  if (status === "confirm") return "text-amber-200";
  return "text-rose-300";
}

function formatAge(ageMs: number) {
  if (ageMs < 60_000) return "<1m";
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)}m`;
  if (ageMs < 24 * 60 * 60_000) return `${Math.floor(ageMs / (60 * 60_000))}h`;
  return `${Math.floor(ageMs / (24 * 60 * 60_000))}d`;
}

function formatPrice(value: number | null) {
  if (value == null) return "—";
  return value >= 1_000 ? value.toFixed(1) : value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
}

function formatUsd(value: number) {
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

function OtherMarketPlan({
  plan,
  onInspect,
}: {
  plan: TerminalPlanSnapshot;
  onInspect: ((plan: TerminalPlanSnapshot) => void) | null;
}) {
  const economics = deriveTerminalPlanEconomics(plan);
  return (
    <article className="flex items-center justify-between gap-2 rounded border border-[#182234] bg-[#0a101a] px-2 py-1.5">
      <div className="min-w-0">
        <h5 className="truncate text-[9px] text-[#dce6f4]">{plan.name}</h5>
        <p className="truncate text-[8px] text-sky-200" title={plan.thesis ?? undefined}>{plan.setup ? `${setupLabel(plan.setup)} · ${plan.thesis}` : "Legacy snapshot"}</p>
        <p className="truncate font-mono text-[8px] uppercase text-[#66738c]">{plan.identity.venue} · {plan.identity.network} · {plan.identity.product} · {plan.identity.interval}</p>
        {economics ? (
          <p className={`truncate font-mono text-[8px] ${economics.withinBudget ? "text-emerald-300" : "text-rose-300"}`}>
            Risk {formatUsd(economics.modeledLossUsd)} / {formatUsd(plan.riskBudgetUsd)} · target +{formatUsd(economics.targetProfitUsd)} · {economics.netRewardRisk.toFixed(2)}R
          </p>
        ) : null}
      </div>
      <button type="button" disabled={!onInspect} onClick={() => onInspect?.(plan)} className="term-chip h-7 shrink-0 px-2 text-[8px] disabled:opacity-40">Inspect</button>
    </article>
  );
}

function setupLabel(setup: TerminalPlanSetup) {
  return setup.replaceAll("_", " ").toUpperCase();
}
