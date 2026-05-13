"use client";

import { useCallback, useEffect, useState } from "react";

// Three modes, one per chat message. Default is Private. The picker UI
// surfaces the choice in the chat header; routing through the right
// transport per mode lights up alongside the /inference/sealed PR.
export type SovereigntyMode = "private" | "local" | "open";

const STORAGE_KEY_PREFIX = "ghola:sovereignty-mode";
const DEFAULT_MODE: SovereigntyMode = "private";

export const SOVEREIGNTY_MODES: ReadonlyArray<{
  id: SovereigntyMode;
  label: string;
  blurb: string;
}> = [
  { id: "private", label: "Private", blurb: "TEE-encrypted. Default." },
  { id: "local", label: "Local", blurb: "On-device only." },
  { id: "open", label: "Open", blurb: "Plaintext. Unverified." },
];

function storageKey(userDid: string | null): string {
  return userDid ? `${STORAGE_KEY_PREFIX}:${userDid}` : STORAGE_KEY_PREFIX;
}

function readMode(userDid: string | null): SovereigntyMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  try {
    const raw = window.localStorage.getItem(storageKey(userDid));
    if (raw === "private" || raw === "local" || raw === "open") return raw;
  } catch {
    // Private-mode browsers and quota errors are fine to swallow —
    // we just fall back to the default for this session.
  }
  return DEFAULT_MODE;
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
  const [mode, setModeState] = useState<SovereigntyMode>(DEFAULT_MODE);

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
// (relay offline, fleet empty, network error) we fall back to the
// plaintext relay path with an honest caveat that the receipt also
// records, rather than silently downgrading the trust label.
export type SovereigntyTransport =
  | "relay-plain"
  | "relay-sealed"
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
  // Honest caveat to surface in the UI / receipt body when a mode
  // hasn't shipped its full guarantee yet (e.g. Private falling back
  // to relay-plain because no enclave is attested).
  caveat?: string;
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
  return "http://localhost:3000";
}

export function thumperRelayBase(): string {
  return relayBase();
}

/**
 * Pick a route for the next message. For Private mode this performs a
 * `GET /providers/attested` lookup — when at least one attested
 * enclave is currently in the pool we return `relay-sealed` with the
 * enclave info attached; otherwise we fall back to `relay-plain` with
 * a caveat that callers stamp into the receipt so the audit trail
 * reflects reality.
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
    case "private": {
      const enclave = await fetchAttestedEnclave(modelId);
      if (enclave) {
        return { mode, transport: "relay-sealed", enclave };
      }
      return {
        mode,
        transport: "relay-plain",
        caveat:
          "No attested enclave currently available — falling back to plaintext relay path. The receipt will be marked unattested.",
      };
    }
    case "local":
      return {
        mode,
        transport: "ghola-home",
        caveat:
          "v1: requires ghola-home running on this machine. WebGPU fallback for small in-browser models lands in v2.",
      };
    case "open":
      return { mode, transport: "relay-plain" };
  }
}

async function fetchAttestedEnclave(
  modelId?: string,
): Promise<AttestedEnclaveInfo | null> {
  try {
    const base = relayBase();
    const url = new URL("/providers/attested", base);
    if (modelId) url.searchParams.set("model", modelId);
    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) return null;
    const list = (await res.json()) as AttestedEnclaveInfo[];
    if (!Array.isArray(list) || list.length === 0) return null;
    // First-wins until latency-aware selection lands. The relay
    // already prefers fresher attestations on its side, so this is
    // good enough for v2.
    return list[0] ?? null;
  } catch {
    // Network error, CORS reject, JSON parse failure — all treated as
    // "no enclave available" and the caller falls back to relay-plain.
    return null;
  }
}
