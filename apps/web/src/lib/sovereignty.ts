"use client";

import { useCallback, useEffect, useState } from "react";

// Four modes, one per chat message. Default is Auto: use this device
// first when it can run the model, then the protected relay, and never
// silently downgrade to Open.
export type SovereigntyMode = "auto" | "private" | "local" | "open";

const STORAGE_KEY_PREFIX = "ghola:sovereignty-mode";
export const NO_ATTESTED_PRIVATE_PROVIDERS_MESSAGE =
  "Private mode is online, but no attested private providers are currently available. Your message was not sent.";
// Auto is the consumer default: local hardware when available, otherwise
// protected cloud, and an explicit ask before Open mode.
const DEFAULT_MODE_AUTHED: SovereigntyMode = "auto";
const DEFAULT_MODE_ANON: SovereigntyMode = "auto";

export const SOVEREIGNTY_MODES: ReadonlyArray<{
  id: SovereigntyMode;
  label: string;
  blurb: string;
}> = [
  { id: "auto", label: "Auto", blurb: "Uses this device first." },
  { id: "private", label: "Private", blurb: "Protected by default." },
  { id: "local", label: "Local", blurb: "On-device only." },
  { id: "open", label: "Open", blurb: "Not private." },
];

function storageKey(userDid: string | null): string {
  return userDid ? `${STORAGE_KEY_PREFIX}:${userDid}` : STORAGE_KEY_PREFIX;
}

// Inline check so this module stays independent of local-inference.ts.
// Key must match PAIR_TOKEN_STORAGE_KEY in apps/web/src/lib/local-inference.ts.
function hasGholaHomePairToken(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("ghola:home-pair-token") !== null;
  } catch {
    return false;
  }
}

export function canUseAutoBrowserLocalAI(): boolean {
  if (typeof navigator === "undefined") return false;
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return false;
  }
  if (!("gpu" in navigator)) return false;
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter?: unknown } })
    .gpu;
  if (typeof gpu?.requestAdapter !== "function") return false;

  const nav = navigator as Navigator & { deviceMemory?: number };
  const ua = nav.userAgent ?? "";
  if (/Android|iPhone|iPod|Mobile/i.test(ua)) return false;
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory < 8)
    return false;
  if (
    typeof nav.hardwareConcurrency === "number" &&
    nav.hardwareConcurrency < 6
  ) {
    return false;
  }
  return true;
}

async function canUseWebGPUAdapter(): Promise<boolean> {
  if (!canUseAutoBrowserLocalAI()) return false;
  try {
    const gpu = (
      navigator as Navigator & {
        gpu?: { requestAdapter?: () => Promise<unknown> };
      }
    ).gpu;
    const adapter = await gpu?.requestAdapter?.();
    return adapter !== null && adapter !== undefined;
  } catch {
    return false;
  }
}

function readMode(userDid: string | null): SovereigntyMode {
  const fallback = userDid ? DEFAULT_MODE_AUTHED : DEFAULT_MODE_ANON;
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(storageKey(userDid));
    if (
      raw === "auto" ||
      raw === "private" ||
      raw === "local" ||
      raw === "open"
    ) {
      return raw;
    }
  } catch {
    // Private-mode browsers and quota errors are fine to swallow —
    // we just fall back to the default for this session.
  }
  return fallback;
}

function writeMode(userDid: string | null, mode: SovereigntyMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(userDid), mode);
  } catch {
    // Same swallow as readMode — persistence is best-effort.
  }
}

// Hook: returns the current mode and a setter that persists it. The
// mode is keyed per user DID so different signed-in identities don't
// trample each other's preference when they share a browser.
export function useSovereigntyMode(userDid: string | null): {
  mode: SovereigntyMode;
  setMode: (m: SovereigntyMode) => void;
} {
  const [mode, setModeState] = useState<SovereigntyMode>(
    userDid ? DEFAULT_MODE_AUTHED : DEFAULT_MODE_ANON,
  );

  useEffect(() => {
    setModeState(readMode(userDid));
  }, [userDid]);

  const setMode = useCallback(
    (m: SovereigntyMode) => {
      setModeState(m);
      writeMode(userDid, m);
    },
    [userDid],
  );

  return { mode, setMode };
}

// Routing. As of v2 (Track H), Private mode queries the relay for an
// attested enclave and — when one is available — routes through the
// sealed transport end-to-end. When no attested enclave is reachable
// (relay offline, fleet empty, network error), the route fails closed
// as `private-unavailable` so callers can require explicit user action
// before any Open-mode send.
export type SovereigntyTransport =
  | "relay-plain"
  | "relay-sealed"
  | "private-unavailable"
  | "webgpu"
  | "ghola-home";

/**
 * Describes a single attested enclave the relay has vetted. Mirrors
 * the shape returned by `GET /providers/attested` on
 * `thumper-relay` — see crates/thumper-relay/src/routes/attested.rs.
 */
export interface AttestedEnclaveInfo {
  enclave_key_id: string;
  provider_id: string;
  tee_kind: "nitro" | "h100_cc" | "phala" | "tdx" | "none";
  enclave_x25519_pub_hex: string;
  enclave_ed25519_pub_hex: string;
  measurement_hex: string;
  expires_at_unix: number;
}

export interface ModeRoute {
  mode: SovereigntyMode;
  transport: SovereigntyTransport;
  // Present iff `transport === "relay-sealed"`. The chat page reads
  // this to seal the request to the enclave's X25519 pub and to know
  // which key id to address the relay's sealed-inference handler.
  enclave?: AttestedEnclaveInfo;
  // Total attested providers visible at routing time. Surfaced in the
  // chat UI as "1 of N providers attested" — this is the Yahya
  // anonymity-set signal: the bigger the pool, the harder it is for
  // any single provider operator to predict which user lands on them.
  // Random selection across the pool means the operator can't even
  // observe selection bias.
  poolSize?: number;
  // Honest caveat to surface in the UI / receipt body when a route
  // cannot satisfy the requested mode as configured.
  caveat?: string;
  reasonCodes?: string[];
}

export interface PrivateAvailability {
  available: boolean;
  reasonCodes: string[];
  reason: string | null;
  attestedProviderCount?: number;
  privateCapacityReady?: boolean;
}

// The relay hosts /providers/attested + /inference/sealed +
// /attestations/:hash. It deploys behind the same hostname as the
// existing thumper-cloud API today, so we default to the same env
// var and let callers override via NEXT_PUBLIC_THUMPER_RELAY_URL when
// the two services split.
function relayBase(): string {
  if (typeof process !== "undefined" && process.env) {
    const relay = process.env.NEXT_PUBLIC_THUMPER_RELAY_URL;
    if (relay) return relay;
    const api = process.env.NEXT_PUBLIC_THUMPER_API_URL;
    if (api) return api;
  }
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return "http://localhost:3000";
    }
  }
  return "https://ghola-relay.onrender.com";
}

export function thumperRelayBase(): string {
  return relayBase();
}

/**
 * Pick a route for the next message. For Private mode this performs a
 * `GET /providers/attested` lookup — when at least one attested
 * enclave is currently in the pool we return `relay-sealed` with the
 * enclave info attached; otherwise we fail closed with
 * `private-unavailable`.
 *
 * `modelId` is forwarded to the relay so the pool can filter to
 * enclaves that have the requested model loaded. Pass `undefined` when
 * the caller doesn't care which enclave handles the request.
 */
export async function selectRoute(
  mode: SovereigntyMode,
  modelId?: string,
): Promise<ModeRoute> {
  switch (mode) {
    case "auto": {
      const paired = hasGholaHomePairToken();
      if (paired) {
        return { mode, transport: "ghola-home" };
      }
      if (await canUseWebGPUAdapter()) {
        return {
          mode,
          transport: "webgpu",
          caveat: "Using this device for this message.",
        };
      }
      const privateRoute = await selectRoute("private", modelId);
      return {
        ...privateRoute,
        mode,
        caveat: privateRoute.caveat,
      };
    }
    case "private": {
      const pool = await fetchAttestedPool(modelId);
      if (pool.length > 0) {
        // Random selection across the attested pool. The Yahya
        // anonymity-set property: any single provider operator can't
        // predict which user sessions land on them, and the pool size
        // is the lower bound on the anonymity set. Output quorum
        // (t-of-k matching responses) is NOT done here — temperature
        // > 0 makes that unreliable, and the attestation-key diversity
        // is the meaningful trust property today. Full quorum work
        // lives in Tier 2F.
        const enclave = pool[Math.floor(Math.random() * pool.length)];
        return {
          mode,
          transport: "relay-sealed",
          enclave,
          poolSize: pool.length,
        };
      }
      const availability = await fetchPrivateAvailability();
      return {
        mode,
        transport: "private-unavailable",
        poolSize: 0,
        reasonCodes: availability.reasonCodes,
        caveat:
          availability.reason ??
          "Private mode unavailable: relay private stack is not ready.",
      };
    }
    case "local": {
      // Default the anonymous front door to in-browser WebGPU inference
      // (Tier 1A) — zero install, zero account, the message never leaves
      // the device. Users who installed ghola-home + paired this browser
      // get routed to it instead so bigger Ollama-hosted models stay
      // reachable from the same picker.
      const paired = hasGholaHomePairToken();
      return {
        mode,
        transport: paired ? "ghola-home" : "webgpu",
        caveat: paired
          ? undefined
          : "Runs in this browser via WebGPU. Requires Chrome, Edge, or Safari 18+.",
      };
    }
    case "open":
      return { mode, transport: "relay-plain" };
  }
}

async function fetchAttestedPool(
  modelId?: string,
): Promise<AttestedEnclaveInfo[]> {
  try {
    const base = relayBase();
    const url = new URL("/providers/attested", base);
    if (modelId) url.searchParams.set("model", modelId);
    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) return [];
    const list = (await res.json()) as AttestedEnclaveInfo[];
    if (!Array.isArray(list)) return [];
    return list;
  } catch {
    // Network error, CORS reject, JSON parse failure — all treated as
    // "no enclave available" and the caller fails closed for Private.
    return [];
  }
}

export async function fetchPrivateAvailability(): Promise<PrivateAvailability> {
  try {
    const url = new URL("/ready/private", relayBase());
    const res = await fetch(url.toString(), { method: "GET" });
    const body = (await res.json().catch(() => null)) as {
      reason_codes?: string[];
      capacity_reason_codes?: string[];
      private_ready?: boolean;
      private_capacity_ready?: boolean;
      attested_provider_count?: number;
    } | null;
    const baseReasonCodes = Array.isArray(body?.reason_codes)
      ? body.reason_codes.filter((v) => typeof v === "string")
      : [];
    const capacityReasonCodes = Array.isArray(body?.capacity_reason_codes)
      ? body.capacity_reason_codes.filter((v) => typeof v === "string")
      : [];
    const reasonCodes = Array.from(
      new Set([...baseReasonCodes, ...capacityReasonCodes]),
    );
    const attestedProviderCount =
      typeof body?.attested_provider_count === "number"
        ? body.attested_provider_count
        : undefined;
    const privateCapacityReady = body?.private_capacity_ready;
    if (
      res.ok &&
      body?.private_ready === true &&
      body.private_capacity_ready !== false
    ) {
      return {
        available: true,
        reasonCodes: [],
        reason: null,
        attestedProviderCount,
        privateCapacityReady,
      };
    }
    if (
      res.ok &&
      body?.private_ready === true &&
      (body.private_capacity_ready === false ||
        reasonCodes.includes("no_attested_private_providers"))
    ) {
      return {
        available: false,
        reasonCodes: reasonCodes.includes("no_attested_private_providers")
          ? reasonCodes
          : [...reasonCodes, "no_attested_private_providers"],
        reason: NO_ATTESTED_PRIVATE_PROVIDERS_MESSAGE,
        attestedProviderCount,
        privateCapacityReady: false,
      };
    }
    const reason = reasonCodes.length
      ? `Private mode unavailable (${reasonCodes.join(", ")}).`
      : "Private mode unavailable (relay readiness check failed).";
    return {
      available: false,
      reasonCodes,
      reason,
      attestedProviderCount,
      privateCapacityReady,
    };
  } catch {
    return {
      available: false,
      reasonCodes: ["private_probe_failed"],
      reason: "Private mode unavailable (readiness probe failed).",
    };
  }
}
