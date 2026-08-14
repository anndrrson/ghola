"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  emptyTerminalRouteCostPolicy,
  inspectTerminalRouteCostPolicy,
  mergeTerminalRouteCostPolicies,
  resetTerminalRouteCostPolicy,
  serializeTerminalRouteCostPolicy,
  terminalRouteCostAssumption,
  terminalRouteCostPolicyStorageKey,
  terminalRouteCostPolicyNextExpiry,
  updateTerminalRouteCostPolicy,
  type TerminalRouteCostField,
  type TerminalRouteCostPolicyInspection,
  type TerminalRouteCostVenue,
} from "./terminal-route-cost-policy";

export interface TerminalRouteCostPolicyController {
  storageKey: string | null;
  loadedStorageKey: string | null;
  inspection: TerminalRouteCostPolicyInspection;
  ready: boolean;
  nowMs: number;
  message: string;
  commit: (venue: TerminalRouteCostVenue, field: TerminalRouteCostField, value: number) => boolean;
  reconfirm: (venue: TerminalRouteCostVenue) => boolean;
  reset: () => boolean;
}

export function useTerminalRouteCostPolicy(
  persistenceScope: string | null,
): TerminalRouteCostPolicyController {
  const storageKey = terminalRouteCostPolicyStorageKey(persistenceScope);
  const [loadedStorageKey, setLoadedStorageKey] = useState<string | null>(null);
  const [inspection, setInspection] = useState<TerminalRouteCostPolicyInspection>(() => ({
    status: "absent",
    policy: emptyTerminalRouteCostPolicy(),
    raw: null,
  }));
  const inspectionRef = useRef(inspection);
  const [message, setMessage] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const updateInspection = useCallback((next: TerminalRouteCostPolicyInspection) => {
    inspectionRef.current = next;
    setInspection(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (!storageKey) {
        setLoadedStorageKey(null);
        updateInspection({ status: "absent", policy: emptyTerminalRouteCostPolicy(), raw: null });
        return;
      }
      try {
        updateInspection(inspectTerminalRouteCostPolicy(window.localStorage.getItem(storageKey)));
      } catch {
        updateInspection({ status: "blocked", policy: null, raw: "storage_unavailable" });
      }
      setLoadedStorageKey(storageKey);
      setMessage("");
      setNowMs(Date.now());
    });
    return () => {
      cancelled = true;
    };
  }, [storageKey, updateInspection]);

  useEffect(() => {
    if (!storageKey) return;
    const activeStorageKey = storageKey;
    function reconcileStorage(event: StorageEvent) {
      if (event.key !== activeStorageKey || (event.storageArea && event.storageArea !== window.localStorage)) return;
      const incoming = inspectTerminalRouteCostPolicy(event.newValue);
      if (incoming.status === "blocked") {
        updateInspection(incoming);
        setMessage("Cost assumptions changed in another tab and are now locked");
        return;
      }
      const current = inspectionRef.current;
      const merged = current.status === "blocked"
        ? incoming.policy
        : mergeTerminalRouteCostPolicies(current.policy, incoming.policy);
      const raw = serializeTerminalRouteCostPolicy(merged);
      if (event.newValue != null && raw !== event.newValue) {
        try {
          window.localStorage.setItem(activeStorageKey, raw);
        } catch {
          updateInspection({ status: "blocked", policy: null, raw: event.newValue });
          return;
        }
      }
      updateInspection({ status: "ready", policy: merged, raw });
      setLoadedStorageKey(activeStorageKey);
      setNowMs(Date.now());
      setMessage("Cost assumptions synchronized from another tab");
    }
    window.addEventListener("storage", reconcileStorage);
    return () => window.removeEventListener("storage", reconcileStorage);
  }, [storageKey, updateInspection]);

  useEffect(() => {
    if (inspection.status === "blocked") return;
    const deadline = terminalRouteCostPolicyNextExpiry(inspection.policy, nowMs);
    if (deadline == null) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.min(2_147_483_647, Math.max(1, deadline - nowMs)));
    return () => window.clearTimeout(timer);
  }, [inspection, nowMs]);

  const commit = useCallback((venue: TerminalRouteCostVenue, field: TerminalRouteCostField, value: number) => {
    if (!storageKey || inspectionRef.current.status === "blocked") return false;
    try {
      const stored = inspectTerminalRouteCostPolicy(window.localStorage.getItem(storageKey));
      if (stored.status === "blocked") {
        updateInspection(stored);
        setMessage("Cost policy is unreadable; existing bytes were preserved");
        return false;
      }
      const current = inspectionRef.current;
      const base = mergeTerminalRouteCostPolicies(current.policy, stored.policy);
      const next = updateTerminalRouteCostPolicy({ policy: base, venue, field, value });
      const raw = serializeTerminalRouteCostPolicy(next);
      window.localStorage.setItem(storageKey, raw);
      updateInspection({ status: "ready", policy: next, raw });
      setLoadedStorageKey(storageKey);
      setNowMs(Date.now());
      setMessage(`${venue} ${field === "feeBps" ? "fee" : "execution buffer"} set to ${value.toFixed(2)} bp`);
      return true;
    } catch {
      setMessage("Enter a valid bounded route-cost assumption");
      return false;
    }
  }, [storageKey, updateInspection]);

  const reset = useCallback(() => {
    if (!storageKey) return false;
    try {
      const next = resetTerminalRouteCostPolicy();
      const raw = serializeTerminalRouteCostPolicy(next);
      window.localStorage.setItem(storageKey, raw);
      updateInspection({ status: "ready", policy: next, raw });
      setLoadedStorageKey(storageKey);
      setNowMs(Date.now());
      setMessage("All route cost assumptions cleared; explicit values are required for live risk checks");
      return true;
    } catch {
      setMessage("Cost policy remains unavailable");
      return false;
    }
  }, [storageKey, updateInspection]);

  const reconfirm = useCallback((venue: TerminalRouteCostVenue) => {
    if (!storageKey || inspectionRef.current.status === "blocked") return false;
    try {
      const stored = inspectTerminalRouteCostPolicy(window.localStorage.getItem(storageKey));
      if (stored.status === "blocked") {
        updateInspection(stored);
        setMessage("Cost policy is unreadable; existing bytes were preserved");
        return false;
      }
      const current = inspectionRef.current;
      const base = mergeTerminalRouteCostPolicies(current.policy, stored.policy);
      const evidence = terminalRouteCostAssumption(base, venue);
      const row = base.venues[venue];
      if (!row || row.feeUpdatedAt <= base.clearedAt || row.bufferUpdatedAt <= base.clearedAt) {
        setMessage(`${venue} requires both assumptions before reconfirmation`);
        return false;
      }
      const now = Date.now();
      const withFee = updateTerminalRouteCostPolicy({ policy: base, venue, field: "feeBps", value: evidence.feeBps, nowMs: now });
      const next = updateTerminalRouteCostPolicy({ policy: withFee, venue, field: "bufferBps", value: evidence.bufferBps, nowMs: now });
      const raw = serializeTerminalRouteCostPolicy(next);
      window.localStorage.setItem(storageKey, raw);
      updateInspection({ status: "ready", policy: next, raw });
      setLoadedStorageKey(storageKey);
      setNowMs(now);
      setMessage(`${venue} fee and execution buffer explicitly reconfirmed`);
      return true;
    } catch {
      setMessage("Cost assumptions could not be reconfirmed");
      return false;
    }
  }, [storageKey, updateInspection]);

  return {
    storageKey,
    loadedStorageKey,
    inspection,
    ready: storageKey != null && loadedStorageKey === storageKey && inspection.status !== "blocked",
    nowMs,
    message,
    commit,
    reconfirm,
    reset,
  };
}
